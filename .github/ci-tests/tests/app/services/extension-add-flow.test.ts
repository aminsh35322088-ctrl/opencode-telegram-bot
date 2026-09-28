import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("../../../src/app/services/skill-manage-service.js", () => ({
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
  resumePendingExtensionAddFromQuestion,
} from "../../../src/app/services/extension-ensure-service.js";

describe("retained Skill automation", () => {
  beforeEach(() => {
    clearSharedExtensionAutomationState();
    vi.clearAllMocks();
    mocks.listExtensions.mockResolvedValue([]);
    mocks.getExtension.mockResolvedValue(null);
    mocks.generateActions.mockResolvedValue(1);
  });

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

    const resumed = await resumePendingExtensionAddFromQuestion({
      sessionId: "ses-skill",
      questions: [{ header: preview.question.header, question: preview.question.question }],
      answers: [["* Add: Check deployments before release"]],
    });
    expect(resumed).toMatchObject({
      handled: true,
      status: "resumed",
      result: {
        status: "ready",
        extension: { id: "skill:deploy-check", kind: "skill" },
      },
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
