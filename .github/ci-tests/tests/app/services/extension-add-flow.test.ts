import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {runWithAuthenticatedMutationActor} from "../../../src/control-plane/actor-context.js";
import {handleApprovedGlobalQuestion, commitPreparedGlobalMutation, runTrustedTelegramGlobalMutation} from "../../../src/control-plane/mutations.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveSkill: vi.fn(),
  writeSkill: vi.fn(),
  saveExtension: vi.fn(),
  getExtension: vi.fn(),
  listExtensions: vi.fn(),
  generateActions: vi.fn(),
}));

vi.mock("../../../src/app/services/skill-import-service.js", () => ({
  resolveSkillSource: mocks.resolveSkill,
}));
vi.mock("../../../src/app/services/skill-manage-service.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../src/app/services/skill-manage-service.js")>(),
  writeGlobalSkillRaw: mocks.writeSkill,
}));
vi.mock("../../../src/app/services/opencode-managed-config-service.js", () => ({
  reloadManagedOpenCodeConfig: vi.fn(),
}));
vi.mock("../../../src/app/services/extension-registry-service.js", () => ({
  extensionId: (kind: string, name: string) => `${kind}:${name.toLowerCase()}`,
  listExtensions: mocks.listExtensions,
}));
vi.mock("../../../src/app/services/extension-store.js", () => ({
  saveStoredExtension: mocks.saveExtension,
  getStoredExtension: mocks.getExtension,
  removeStoredExtension: vi.fn(),
}));
vi.mock("../../../src/app/services/extension-action-generator-service.js", () => ({
  generateExtensionActions: mocks.generateActions,
}));

import { clearSharedExtensionAutomationState } from "../../../src/app/services/extension-automation-state-store.js";
import {
  addSkillExtension,
  adoptPendingSkillQuestion,
  resumePendingExtensionAddFromQuestion,
} from "../../../src/app/services/extension-ensure-service.js";

describe("retained Skill automation", () => {
  let home = "";
  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "extension-add-approval-"));
    vi.stubEnv("OPENCODE_TELEGRAM_HOME", home);
    clearSharedExtensionAutomationState();
    vi.clearAllMocks();
    mocks.listExtensions.mockResolvedValue([]);
    mocks.getExtension.mockResolvedValue(null);
    mocks.generateActions.mockResolvedValue(1);
  });

  afterEach(async () => { await fs.rm(home, {recursive: true, force: true}); });

  it("previews and deterministically installs a detected Skill", async () => {
    mocks.resolveSkill.mockResolvedValue({
      kind: "single",
      skill: {
        name: "deploy-check",
        description: "Check deployments before release",
        content: "# Deploy check",
        sourceUrl: "https://github.com/example/skills/tree/main/deploy-check",
      },
    });

    const preview = await addSkillExtension({
      sessionId: "ses-skill",
      projectDirectory: "/work/repo",
      source: "https://github.com/example/skills/tree/main/deploy-check",
    });
    expect(preview.status).toBe("question-required");
    if (preview.status !== "question-required") throw new Error("Expected question preview");
    expect(mocks.writeSkill).not.toHaveBeenCalled();

    await expect(addSkillExtension({sessionId:"ses-skill",projectDirectory:"/work/repo",source:"https://github.com/example/skills",confirmed:true})).rejects.toThrow(/cannot approve/);
    const actor = {nodeId:"node",generation:1,chatId:10,threadId:20,sessionId:"ses-skill"};
    await runWithAuthenticatedMutationActor(actor, async () => {
      await adoptPendingSkillQuestion(actor, "exact-question", [preview.question]);
      await expect(handleApprovedGlobalQuestion({actor,requestId:"exact-question",questions:[preview.question],answers:[["Add"]]})).rejects.toThrow(/requires an approved Question/);
      const receipt = await runTrustedTelegramGlobalMutation("question.approve", "exact-question", () => handleApprovedGlobalQuestion({actor,requestId:"exact-question",questions:[preview.question],answers:[["Add"]]}));
      if (!receipt) throw new Error("Expected exact Question receipt");
      const committed = await commitPreparedGlobalMutation(actor,receipt.approvalId,{type:receipt.type,resource:receipt.resource,config:receipt.config});
      expect(committed).toMatchObject({status:"committed",result:{status:"ready",extension:{id:"skill:deploy-check",kind:"skill"}}});
      expect(mocks.resolveSkill).toHaveBeenCalledTimes(1);
    });
    expect(mocks.writeSkill).toHaveBeenCalledWith("deploy-check", "# Deploy check");
    expect(mocks.generateActions).toHaveBeenCalledWith(expect.objectContaining({
      id: "skill:deploy-check",
    }));
  });

  it("offers Cancel when a source contains multiple Skills", async () => {
    mocks.resolveSkill.mockResolvedValue({
      kind: "list",
      candidates: [
        { name: "deploy-check", url: "https://github.com/example/skills/tree/main/deploy-check" },
        { name: "release-check", url: "https://github.com/example/skills/tree/main/release-check" },
      ],
    });

    const preview = await addSkillExtension({
      sessionId: "ses-skill-list",
      projectDirectory: "/work/repo",
      source: "https://github.com/example/skills",
    });
    expect(preview).toMatchObject({
      status: "question-required",
      kind: "skill",
      question: {
        header: "Choose Skill",
        options: [
          expect.objectContaining({ label: "deploy-check" }),
          expect.objectContaining({ label: "release-check" }),
          expect.objectContaining({ label: "Cancel" }),
        ],
      },
    });
    if (preview.status !== "question-required") throw new Error("Expected Skill selection");

    await expect(resumePendingExtensionAddFromQuestion({
      sessionId: "ses-skill-list",
      questions: [{ header: preview.question.header, question: preview.question.question }],
      answers: [["* Cancel: Do not install a skill from this source."]],
    })).resolves.toMatchObject({ handled: true, status: "cancelled" });
    expect(mocks.writeSkill).not.toHaveBeenCalled();
  });
});
