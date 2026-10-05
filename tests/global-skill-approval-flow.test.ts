import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import {mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

test("legacy Skill Question and candidate choice migrate into exact frozen ledger approvals", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "skill-approval-"));
  process.env.OPENCODE_TELEGRAM_HOME = home;
  process.env.TELEGRAM_BOT_TOKEN = "123:test-fixture";
  process.env.TELEGRAM_ALLOWED_USER_ID = "123";
  const originalFetch = globalThis.fetch;
  try {
    const {runWithAuthenticatedMutationActor} = await import("../src/control-plane/actor-context.js");
    const {writeSharedPendingAdd} = await import("../src/app/services/extension-automation-state-store.js");
    const {adoptPendingSkillQuestion, resumePendingExtensionAddFromQuestion, addSkillExtension} = await import("../src/app/services/extension-ensure-service.js");
    const {handleApprovedGlobalQuestion: issueReceipt, runTrustedTelegramGlobalMutation, bindGlobalMutationQuestion, commitPreparedGlobalMutation} = await import("../src/control-plane/mutations.js");
    const handleApprovedGlobalQuestion = (input: Parameters<typeof issueReceipt>[0]) => runTrustedTelegramGlobalMutation("question.approve", input.requestId, () => issueReceipt(input));
    const actor = {nodeId: "node", generation: 1, chatId: 10, threadId: 20, sessionId: "session"};
    const content = '---\nname: frozen\ndescription: Frozen inspection\n---\n\nInspected bytes.\n';
    const source = `https://raw.githubusercontent.com/example/repo/${"a".repeat(40)}/frozen/SKILL.md`;
    const question = {header: "Add Skill", question: "Add frozen to the bot?", options: [{label:"Add",description:"Frozen inspection"}, {label:"Cancel",description:"Cancel"}], multiple:false as const};
    writeSharedPendingAdd({sessionId: actor.sessionId, projectDirectory: home, kind:"skill", source, name:"frozen", purpose:"Frozen inspection", inspectedContent:content, inspectedHash:createHash("sha256").update(content).digest("hex"), question:{header:question.header,question:question.question}, choices:[{label:"Add",action:"add"},{label:"Cancel",action:"cancel"}],createdAt:Date.now(),expiresAt:Date.now()+60_000});
    await assert.rejects(addSkillExtension({sessionId:actor.sessionId,projectDirectory:home,source,confirmed:true}), /cannot approve/);
    await runWithAuthenticatedMutationActor(actor, async () => {
      globalThis.fetch = async () => { throw new Error("Sources must not be fetched after inspection."); };
      await adoptPendingSkillQuestion(actor, "legacy-question", [question]);
      assert.equal(await handleApprovedGlobalQuestion({actor:{...actor,threadId:21},requestId:"legacy-question",questions:[question],answers:[["Add"]]}), null);
      const receipt = await handleApprovedGlobalQuestion({actor,requestId:"legacy-question",questions:[question],answers:[["Add"]]});
      assert.ok(receipt);
      await commitPreparedGlobalMutation(actor, receipt.approvalId, {type:receipt.type,resource:receipt.resource,config:receipt.config});
      assert.equal(await readFile(path.join(home,".config/opencode/skills/frozen/SKILL.md"),"utf8"), content);
      const candidateContent = content.replaceAll("frozen","candidate");
      const candidateSource = source.replace("frozen","candidate");
      const selection = {header:"Choose Skill",question:"Which skill do you want to add?"};
      writeSharedPendingAdd({sessionId:actor.sessionId,projectDirectory:home,kind:"skill",source:"https://github.com/example/repo",question:selection,choices:[{label:"candidate",action:"add",source:candidateSource},{label:"Cancel",action:"cancel"}],createdAt:Date.now(),expiresAt:Date.now()+60_000});
      globalThis.fetch = async () => new Response(candidateContent, {status:200});
      const resumed = await resumePendingExtensionAddFromQuestion({sessionId:actor.sessionId,questions:[selection],answers:[["candidate"]]});
      assert.ok(resumed.handled && resumed.status === "approval-required");
      await assert.rejects(readFile(path.join(home,".config/opencode/skills/candidate/SKILL.md")));
      globalThis.fetch = async () => { throw new Error("Candidate must not be refetched at commit."); };
      await bindGlobalMutationQuestion(actor,"candidate-approval",[resumed.result.question]);
      const approved = await handleApprovedGlobalQuestion({actor,requestId:"candidate-approval",questions:[resumed.result.question],answers:[["Approve"]]});
      assert.ok(approved);
      await commitPreparedGlobalMutation(actor,approved.approvalId,{type:approved.type,resource:approved.resource,config:approved.config});
      assert.equal(await readFile(path.join(home,".config/opencode/skills/candidate/SKILL.md"),"utf8"),candidateContent);
    });
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.OPENCODE_TELEGRAM_HOME;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_ALLOWED_USER_ID;
    await rm(home,{recursive:true,force:true});
  }
});
