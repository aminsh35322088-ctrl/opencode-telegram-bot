import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  prepareGlobalMutation,
  bindGlobalMutationQuestion,
  handleApprovedGlobalQuestion,
  commitGlobalMutationApproved,
  readGlobalMutationApproval,
  runTrustedTelegramGlobalMutation,
} from "../src/control-plane/mutations.js";
import {
  writeGlobalSkill,
  writeGlobalSkillRaw,
  updateGlobalSkill,
  deleteGlobalSkill,
} from "../src/app/services/skill-manage-service.js";
import { updateAppState } from "../src/app/stores/app-state-store.js";

test("Global mutation approval binds exact Question, actor, generation, config and is consumed once", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "global-approval-"));
  process.env.OPENCODE_TELEGRAM_HOME = home;
  const actor = { nodeId: "node", generation: 2, chatId: 10, threadId: 20, sessionId: "session" };
  const mutation = {
    type: "skills.create",
    resource: "example",
    config: { description: "Description", body: "Body" },
  };
  try {
    await assert.rejects(
      writeGlobalSkill({ name: "bypass", description: "x", body: "x" }),
      /requires an approved/,
    );
    await assert.rejects(writeGlobalSkillRaw("bypass", "content"), /requires an approved/);
    await assert.rejects(
      updateGlobalSkill({ name: "bypass", description: "x", body: "x" }),
      /requires an approved/,
    );
    await assert.rejects(deleteGlobalSkill("bypass"), /requires an approved/);
    const prepared = await prepareGlobalMutation(actor, mutation);
    let calls = 0;
    const apply = async () => {
      calls++;
      await updateAppState({ settings: { language: "en" } });
    };
    await assert.rejects(commitGlobalMutationApproved(actor, prepared.approvalId, mutation, apply));
    await bindGlobalMutationQuestion(actor, "question-1", [prepared.question]);
    await assert.rejects(handleApprovedGlobalQuestion({actor, requestId:"question-1", questions:[prepared.question], answers:[["Approve"]]}), /requires an approved/);
    const approve = (boundActor = actor, requestId = "question-1", answer = "Approve") =>
      runTrustedTelegramGlobalMutation("question.approve", requestId, () => handleApprovedGlobalQuestion({
        actor: boundActor,
        requestId,
        questions: [prepared.question],
        answers: [[answer]],
      }));
    assert.equal(await approve({ ...actor, threadId: 21 }), null);
    assert.equal(await approve({ ...actor, sessionId: "another" }), null);
    assert.equal(await approve({ ...actor, generation: 3 }), null);
    assert.equal(await approve(actor, "question-other"), null);
    assert.equal((await approve())?.status, "approved");
    await assert.rejects(
      commitGlobalMutationApproved(
        { ...actor, nodeId: "other" },
        prepared.approvalId,
        mutation,
        apply,
      ),
    );
    await assert.rejects(
      commitGlobalMutationApproved(
        actor,
        prepared.approvalId,
        { ...mutation, config: { body: "changed" } },
        apply,
      ),
    );
    await commitGlobalMutationApproved(actor, prepared.approvalId, mutation, apply);
    await commitGlobalMutationApproved(actor, prepared.approvalId, mutation, apply);
    assert.equal(calls, 1);
    assert.equal(await approve(), null);
    const rejected = await prepareGlobalMutation(actor, mutation);
    await bindGlobalMutationQuestion(actor, "question-2", [rejected.question]);
    await runTrustedTelegramGlobalMutation("question.approve", "question-2", () => handleApprovedGlobalQuestion({
      actor,
      requestId: "question-2",
      questions: [rejected.question],
      answers: [["Reject"]],
    }));
    await assert.rejects(commitGlobalMutationApproved(actor, rejected.approvalId, mutation, apply));
    const expired = await prepareGlobalMutation(actor, mutation);
    const pending = await readGlobalMutationApproval(expired.approvalId);
    await updateAppState((state) => ({
      globalMutationApprovals: {
        ...(state.globalMutationApprovals as object),
        [expired.approvalId]: { ...pending, expiresAt: 0, status: "approved" },
      },
    }));
    await assert.rejects(commitGlobalMutationApproved(actor, expired.approvalId, mutation, apply));
    assert.equal(calls, 1);
  } finally {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await rm(home, { recursive: true, force: true });
  }
});
