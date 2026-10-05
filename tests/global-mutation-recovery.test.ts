import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp, mkdir, readFile, writeFile, rm, chmod, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {prepareGlobalMutation, bindGlobalMutationQuestion, handleApprovedGlobalQuestion, runTrustedTelegramGlobalMutation, commitGlobalMutationApproved, readGlobalMutationApproval, recoverInterruptedGlobalMutationApprovals, type PendingGlobalMutation} from "../src/control-plane/mutations.js";
import {readAppState, updateAppState} from "../src/app/stores/app-state-store.js";
import {commitGlobalMutation} from "../src/control-plane/global-state.js";

const actor = {nodeId:"node",generation:1,chatId:10,threadId:20,sessionId:"session"};
const mutation = {type:"skills.update",resource:"example",config:{description:"Description",body:"Body"}};
const intended = '---\nname: example\ndescription: "Description"\n---\n\nBody\n';
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
async function approved(input = mutation) {
  const prepared = await prepareGlobalMutation(actor, input);
  assert.ok("approvalId" in prepared);
  await bindGlobalMutationQuestion(actor,"question",[prepared.question]);
  const receipt = await runTrustedTelegramGlobalMutation("question.approve","question",() => handleApprovedGlobalQuestion({actor,requestId:"question",questions:[prepared.question],answers:[["Approve"]]}));
  assert.ok(receipt);
  return receipt;
}
async function replaceApproval(pending: PendingGlobalMutation) {
  await updateAppState(state => ({globalMutationApprovals:{...state.globalMutationApprovals as object,[pending.approvalId]:pending}}));
}
async function fixture(run: (file: string) => Promise<void>) {
  const home = await mkdtemp(path.join(tmpdir(),"approval-recovery-"));
  process.env.OPENCODE_TELEGRAM_HOME = home;
  const file = path.join(home,".config/opencode/skills/example/SKILL.md");
  await mkdir(path.dirname(file),{recursive:true});
  await writeFile(file,"Original bytes\n");
  try {await run(file);} finally {delete process.env.OPENCODE_TELEGRAM_HOME;await rm(home,{recursive:true,force:true});}
}

test("failed exact Skill write restores original bytes and cannot replay its receipt", async () => fixture(async file => {
  const pending = await approved();
  await assert.rejects(commitGlobalMutationApproved(actor,pending.approvalId,mutation,async () => {await writeFile(file,intended);throw new Error("after filesystem write");}), /after filesystem write/);
  assert.equal(await readFile(file,"utf8"),"Original bytes\n");
  const failed = await readGlobalMutationApproval(pending.approvalId);
  assert.equal(failed?.status,"failed");assert.equal(failed?.recoveryRequired,false);
  let calls = 0;
  await assert.rejects(commitGlobalMutationApproved(actor,pending.approvalId,mutation,async () => {calls++;}));
  assert.equal(calls,0);
}));

test("unknown partial Skill bytes are preserved and flagged for recovery rather than overwritten", async () => fixture(async file => {
  const pending = await approved();
  await assert.rejects(commitGlobalMutationApproved(actor,pending.approvalId,mutation,async () => {await writeFile(file,"Unexpected partial bytes");throw new Error("partial write");}));
  assert.equal(await readFile(file,"utf8"),"Unexpected partial bytes");
  const failed = await readGlobalMutationApproval(pending.approvalId);
  assert.equal(failed?.status,"failed");assert.equal(failed?.recoveryRequired,true);
  let calls = 0;
  await assert.rejects(commitGlobalMutationApproved(actor,pending.approvalId,mutation,async () => {calls++;}));
  assert.equal(calls,0);
}));

test("startup recovery restores orphaned exact Skill effects and permanently consumes that failed attempt", async () => fixture(async file => {
  const pending = await approved();
  await replaceApproval({...pending,status:"committing",attemptId:"previous-process",externalEffect:{kind:"skill-write",beforeContentBase64:Buffer.from("Original bytes\n").toString("base64"),beforeHash:hash("Original bytes\n"),expectedHash:hash(intended),mode:0o600}});
  await writeFile(file,intended);
  assert.deepEqual(await recoverInterruptedGlobalMutationApprovals(),{recovered:1,recoveryRequired:0});
  assert.equal(await readFile(file,"utf8"),"Original bytes\n");
  assert.equal((await readGlobalMutationApproval(pending.approvalId))?.status,"failed");
  assert.deepEqual(await recoverInterruptedGlobalMutationApprovals(),{recovered:0,recoveryRequired:0});
  let calls = 0;
  await assert.rejects(commitGlobalMutationApproved(actor,pending.approvalId,mutation,async () => {calls++;}));
  assert.equal(calls,0);
}));

test("exact canonical receipts reconcile a crash after commit without applying again, even after approval expiry", async () => fixture(async file => {
  const pending = await approved();
  await replaceApproval({...pending,status:"committing",attemptId:"old-process"});
  const snapshot = await commitGlobalMutation({type:pending.type,resource:pending.resource,actorTopicId:pending.actorTopicId,sessionId:pending.sessionId,configHash:pending.configHash,approvalId:pending.approvalId},async () => {await writeFile(file,intended);});
  const committing = await readGlobalMutationApproval(pending.approvalId);
  await replaceApproval({...committing!,expiresAt:0});
  let calls = 0;
  await assert.rejects(commitGlobalMutationApproved({...actor,generation:2},pending.approvalId,mutation,async () => {calls++;}));
  const replay = await commitGlobalMutationApproved(actor,pending.approvalId,mutation,async () => {calls++;});
  assert.deepEqual(replay,{status:"committed",approvalId:pending.approvalId,revision:snapshot.revision});
  assert.equal(calls,0);assert.equal(await readFile(file,"utf8"),intended);
  assert.equal((await readGlobalMutationApproval(pending.approvalId))?.status,"committed");
}));

test("orphan without a canonical receipt never replays unknown side effects", async () => fixture(async () => {
  const pending = await approved();
  await replaceApproval({...pending,status:"committing",attemptId:"old-process"});
  let calls = 0;
  await assert.rejects(commitGlobalMutationApproved(actor,pending.approvalId,mutation,async () => {calls++;}), /no operation was replayed/);
  assert.equal(calls,0);assert.equal((await readGlobalMutationApproval(pending.approvalId))?.recoveryRequired,true);
}));

test("mismatched canonical receipt cannot authorize replay or automatic rollback", async () => fixture(async file => {
  const pending = await approved();
  await replaceApproval({...pending,status:"committing",attemptId:"old-process",externalEffect:{kind:"skill-write",beforeContentBase64:Buffer.from("Original bytes\n").toString("base64"),beforeHash:hash("Original bytes\n"),expectedHash:hash(intended),mode:0o600}});
  await writeFile(file,intended);
  await updateAppState({globalMutationReceipts:{[pending.approvalId]:{type:pending.type,resource:"another-resource",actorTopicId:pending.actorTopicId,sessionId:pending.sessionId,configHash:pending.configHash,revision:1}}});
  let calls = 0;
  await assert.rejects(commitGlobalMutationApproved(actor,pending.approvalId,mutation,async () => {calls++;}));
  assert.equal(calls,0);assert.equal(await readFile(file,"utf8"),intended);
  const failed = await readGlobalMutationApproval(pending.approvalId);
  assert.equal(failed?.failureCode,"receipt-mismatch");assert.equal(failed?.recoveryRequired,true);
}));

test("approval terminal state and canonical receipt commit together; concurrent duplicate applies once", async () => fixture(async file => {
  const pending = await approved();
  let release!: () => void;let entered!: () => void;
  const gate = new Promise<void>(resolve => {release=resolve;});
  const started = new Promise<void>(resolve => {entered=resolve;});
  let calls = 0;
  const apply = async () => {calls++;entered();await gate;await writeFile(file,intended);};
  const first = commitGlobalMutationApproved(actor,pending.approvalId,mutation,apply);
  await started;
  const duplicate = commitGlobalMutationApproved(actor,pending.approvalId,mutation,apply);
  const recovery = recoverInterruptedGlobalMutationApprovals();
  release();
  await first;await duplicate;
  assert.equal(calls,1);assert.deepEqual(await recovery,{recovered:0,recoveryRequired:0});
  const state = await readAppState();
  assert.equal((state.globalMutationApprovals as Record<string,PendingGlobalMutation>)[pending.approvalId]?.status,"committed");
  assert.equal((state.globalMutationApprovals as Record<string,PendingGlobalMutation>)[pending.approvalId]?.externalEffect,undefined);
  assert.equal((state.globalMutationReceipts as Record<string,{configHash:string}>)[pending.approvalId]?.configHash,pending.configHash);
}));

test("trusted UI writers share the canonical queue and cannot race compensation", async () => fixture(async file => {
  const pending = await approved();
  let entered!: () => void;let release!: () => void;
  const started = new Promise<void>(resolve => {entered=resolve;});
  const gate = new Promise<void>(resolve => {release=resolve;});
  const failing = commitGlobalMutationApproved(actor,pending.approvalId,mutation,async () => {await writeFile(file,intended);entered();await gate;throw new Error("rollback before next writer");});
  await started;
  let uiStarted = false;
  const ui = runTrustedTelegramGlobalMutation("skills.update","example",async () => {uiStarted=true;assert.equal(await readFile(file,"utf8"),"Original bytes\n");await writeFile(file,"Later UI bytes");return "UI result";});
  await Promise.resolve();assert.equal(uiStarted,false);
  release();
  await assert.rejects(failing,/rollback before next writer/);
  assert.equal(await ui,"UI result");assert.equal(await readFile(file,"utf8"),"Later UI bytes");
  assert.equal((await readGlobalMutationApproval(pending.approvalId))?.recoveryRequired,false);
}));

test("trusted UI scope joins an existing canonical transaction without deadlock", async () => fixture(async file => {
  const {transactAppState} = await import("../src/app/stores/app-state-store.js");
  const {assertGlobalMutationBackend} = await import("../src/control-plane/mutations.js");
  await transactAppState(async () => {
    const result = await runTrustedTelegramGlobalMutation("skills.update","example",async () => {assertGlobalMutationBackend("skills.update","example");await writeFile(file,intended);await updateAppState({settings:{language:"en"}});return 42;});
    assert.equal(result,42);assert.equal((await readAppState()).settings?.language,"en");
  });
  assert.equal(await readFile(file,"utf8"),intended);
  assert.throws(() => assertGlobalMutationBackend("skills.update","example"), /requires an approved/);
}));

test("recovery never rolls back bytes subsequently accepted by a trusted canonical writer", async () => fixture(async file => {
  const pending = await approved();
  await replaceApproval({...pending,status:"committing",attemptId:"old-process",externalEffect:{kind:"skill-write",beforeContentBase64:Buffer.from("Original bytes\n").toString("base64"),beforeHash:hash("Original bytes\n"),expectedHash:hash(intended),mode:0o600}});
  await writeFile(file,intended);
  await runTrustedTelegramGlobalMutation("skills.update","example",async () => {await writeFile(file,intended);});
  assert.deepEqual(await recoverInterruptedGlobalMutationApprovals(),{recovered:1,recoveryRequired:1});
  assert.equal(await readFile(file,"utf8"),intended);
  assert.equal((await readGlobalMutationApproval(pending.approvalId))?.status,"failed");
}));

test("failed new Skill creation removes only its exact artifact and leaves unrelated files", async () => fixture(async file => {
  const create = {...mutation,type:"skills.create",resource:"new-skill"};
  const pending = await approved(create);
  const created = path.join(path.dirname(path.dirname(file)),"new-skill/SKILL.md");
  const unrelated = path.join(path.dirname(created),"notes.txt");
  await assert.rejects(commitGlobalMutationApproved(actor,pending.approvalId,create,async () => {await mkdir(path.dirname(created));await writeFile(unrelated,"Keep these bytes");await writeFile(created,intended.replace("name: example","name: new-skill"));throw new Error("failure after creation");}));
  await assert.rejects(readFile(created));
  assert.equal(await readFile(unrelated,"utf8"),"Keep these bytes");
  assert.equal((await readGlobalMutationApproval(pending.approvalId))?.recoveryRequired,false);
}));

test("Skill before-image compensation preserves original permissions", async () => fixture(async file => {
  await chmod(file,0o666);
  const pending = await approved();
  await assert.rejects(commitGlobalMutationApproved(actor,pending.approvalId,mutation,async () => {await writeFile(file,intended);throw new Error("restore permissions");}));
  assert.equal((await stat(file)).mode & 0o777,0o666);
  assert.equal(await readFile(file,"utf8"),"Original bytes\n");
}));
