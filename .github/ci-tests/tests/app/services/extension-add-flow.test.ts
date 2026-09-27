import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  analyze: vi.fn(),
  createMcp: vi.fn(),
  startOAuth: vi.fn(),
  completeOAuth: vi.fn(),
  loadMcps: vi.fn(),
  configureSecure: vi.fn(),
  resolveSkill: vi.fn(),
  writeSkill: vi.fn(),
  saveExtension: vi.fn(),
  getExtension: vi.fn(),
  removeExtension: vi.fn(),
  listExtensions: vi.fn(),
  createChallenge: vi.fn(),
  generateActions: vi.fn(),
  resolveCredential: vi.fn(),
}));

vi.mock("../../../src/app/services/mcp-server-service.js", () => ({
  analyzeRemoteMcpEndpoint: mocks.analyze,
  createMcpServerFromInput: mocks.createMcp,
  startMcpOAuth: mocks.startOAuth,
  completeMcpOAuth: mocks.completeOAuth,
  loadMcpServers: mocks.loadMcps,
  configureSecureMcpAuth: mocks.configureSecure,
}));
vi.mock("../../../src/app/services/skill-import-service.js", () => ({
  resolveSkillSource: mocks.resolveSkill,
}));
vi.mock("../../../src/app/services/skill-manage-service.js", () => ({
  writeGlobalSkillRaw: mocks.writeSkill,
}));
vi.mock("../../../src/app/services/custom-provider-service.js", () => ({
  discoverModels: vi.fn(),
  saveCustomProvider: vi.fn(),
}));
vi.mock("../../../src/app/services/opencode-managed-config-service.js", () => ({
  reloadManagedOpenCodeConfig: vi.fn(),
}));
vi.mock("../../../src/app/services/secure-credential-broker.js", () => ({
  createSecureCredentialChallenge: mocks.createChallenge,
}));
vi.mock("../../../src/app/services/credential-vault-service.js", () => ({
  resolveExtensionCredential: mocks.resolveCredential,
}));
vi.mock("../../../src/app/services/extension-registry-service.js", () => ({
  extensionId: (kind: string, name: string) => `${kind}:${name.toLowerCase()}`,
  listExtensions: mocks.listExtensions,
}));
vi.mock("../../../src/app/services/extension-store.js", () => ({
  saveStoredExtension: mocks.saveExtension,
  getStoredExtension: mocks.getExtension,
  removeStoredExtension: mocks.removeExtension,
}));
vi.mock("../../../src/app/services/extension-action-generator-service.js", () => ({
  generateExtensionActions: mocks.generateActions,
}));

import { clearSharedExtensionAutomationState } from "../../../src/app/services/extension-automation-state-store.js";
import {
  addMcpBackedExtension,
  addSkillExtension,
  completeExtensionOAuth,
  finalizeExtensionCredential,
  getPendingExtensionOAuth,
  resumePendingExtensionAddFromQuestion,
  verifyPendingExtensionOAuth,
} from "../../../src/app/services/extension-ensure-service.js";
describe("conversational Extension add flows", () => {
  beforeEach(() => {
    clearSharedExtensionAutomationState();
    vi.clearAllMocks();
    mocks.listExtensions.mockResolvedValue([]);
    mocks.getExtension.mockResolvedValue(null);
    mocks.analyze.mockResolvedValue({
      url: "https://api.graphify.com/mcp",
      reachable: true,
      status: 401,
      authHint: "oauth-likely",
      note: "OAuth metadata advertised",
    });
    mocks.createChallenge.mockResolvedValue({
      challengeId: "challenge-1",
    });
    mocks.generateActions.mockResolvedValue(2);
    mocks.resolveCredential.mockResolvedValue("secret-value");
    mocks.loadMcps.mockResolvedValue([]);
  });

  it("analyzes an MCP endpoint and requires native Question confirmation before mutation", async () => {
    const result = await addMcpBackedExtension({
      sessionId: "ses-1",
      projectDirectory: "/work/repo",
      name: "graphify",
      kind: "mcp",
      source: "https://api.graphify.com/mcp",
      purpose: "Repository graph analysis",
    });

    expect(result).toMatchObject({
      status: "question-required",
      kind: "mcp",
      question: {
        header: "Add MCP Server",
        multiple: false,
      },
      questionTool: {
        tool: "question",
        arguments: {
          questions: [
            expect.objectContaining({
              header: "Add MCP Server",
              multiple: false,
            }),
          ],
        },
      },
    });
    expect(mocks.analyze).toHaveBeenCalledTimes(1);
    expect(mocks.createMcp).not.toHaveBeenCalled();
    expect(mocks.saveExtension).not.toHaveBeenCalled();
  });
  it("resumes MCP installation from the Question answer without a second model add call", async () => {
    mocks.createMcp.mockResolvedValue({
      name: "graphify",
      type: "remote",
      status: { status: "needs_auth" },
    });
    mocks.startOAuth.mockResolvedValue({
      authorizationUrl: "https://graphify.example/oauth/authorize",
      oauthState: "oauth-state",
    });

    const preview = await addMcpBackedExtension({
      sessionId: "ses-deterministic",
      projectDirectory: "/work/repo",
      name: "graphify",
      kind: "mcp",
      source: "https://api.graphify.com/mcp",
      purpose: "Repository graph analysis",
    });
    expect(preview.status).toBe("question-required");
    if (preview.status !== "question-required") throw new Error("Expected question preview");

    const resumed = await resumePendingExtensionAddFromQuestion({
      sessionId: "ses-deterministic",
      questions: [{
        header: preview.question.header,
        question: preview.question.question,
      }],
      answers: [["* Add: Use OpenCode automatic MCP authentication discovery."]],
    });

    expect(resumed).toMatchObject({
      handled: true,
      status: "resumed",
      result: {
        status: "awaiting-oauth",
        authorizationUrl: "https://graphify.example/oauth/authorize",
      },
    });
    expect(mocks.createMcp).toHaveBeenCalledTimes(1);
    expect(mocks.startOAuth).toHaveBeenCalledWith("/work/repo", "graphify");
    expect(getPendingExtensionOAuth("ses-deterministic")).toMatchObject({
      serverName: "graphify",
      authorizationUrl: "https://graphify.example/oauth/authorize",
    });
  });

  it("resumes Skill installation from the Question answer without a second model add call", async () => {
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
      sessionId: "ses-skill-deterministic",
      projectDirectory: "/work/repo",
      source: "https://github.com/example/skills/tree/main/deploy-check",
    });
    expect(preview.status).toBe("question-required");
    if (preview.status !== "question-required") throw new Error("Expected question preview");

    const resumed = await resumePendingExtensionAddFromQuestion({
      sessionId: "ses-skill-deterministic",
      questions: [{
        header: preview.question.header,
        question: preview.question.question,
      }],
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

  it("does not resume a pending Extension from an unrelated Question", async () => {
    await addMcpBackedExtension({
      sessionId: "ses-unrelated",
      projectDirectory: "/work/repo",
      name: "graphify",
      kind: "mcp",
      source: "https://api.graphify.com/mcp",
      purpose: "Repository graph analysis",
    });

    await expect(resumePendingExtensionAddFromQuestion({
      sessionId: "ses-unrelated",
      questions: [{ header: "Other", question: "Do something else?" }],
      answers: [["* Yes: do it"]],
    })).resolves.toEqual({ handled: false });
    expect(mocks.createMcp).not.toHaveBeenCalled();
  });

  it("auto-detects needs_auth and starts OAuth without a permission request", async () => {
    mocks.createMcp.mockResolvedValue({
      name: "graphify",
      type: "remote",
      status: { status: "needs_auth" },
    });
    mocks.startOAuth.mockResolvedValue({
      authorizationUrl: "https://graphify.example/oauth/authorize",
      oauthState: "oauth-state",
    });

    const result = await addMcpBackedExtension({
      sessionId: "ses-oauth",
      projectDirectory: "/work/repo",
      name: "graphify",
      kind: "mcp",
      source: "https://api.graphify.com/mcp",
      purpose: "Repository graph analysis",
      confirmed: true,
    });

    expect(result).toMatchObject({
      status: "awaiting-oauth",
      authorizationUrl: "https://graphify.example/oauth/authorize",
    });
    expect(mocks.startOAuth).toHaveBeenCalledWith("/work/repo", "graphify");
    expect(getPendingExtensionOAuth("ses-oauth")).toMatchObject({
      serverName: "graphify",
      authorizationUrl: "https://graphify.example/oauth/authorize",
    });
  });
  it("completes MCP OAuth from the Check path when OpenCode reports connected", async () => {
    mocks.createMcp.mockResolvedValue({
      name: "graphify",
      type: "remote",
      status: { status: "needs_auth" },
    });
    mocks.startOAuth.mockResolvedValue({
      authorizationUrl: "https://graphify.example/oauth/authorize",
      oauthState: "oauth-state",
    });
    const extension = {
      id: "mcp:graphify",
      name: "graphify",
      kind: "mcp",
      source: "https://api.graphify.com/mcp",
      purpose: "Repository graph analysis",
      authType: "oauth",
      credentialSchemas: [],
      resource: { kind: "mcp", serverName: "graphify", projectDirectory: "/work/repo" },
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
      managed: true,
    };
    mocks.getExtension.mockResolvedValue(extension);
    mocks.loadMcps.mockResolvedValue([
      { name: "graphify", type: "remote", status: { status: "connected" } },
    ]);

    await addMcpBackedExtension({
      sessionId: "ses-oauth-check",
      projectDirectory: "/work/repo",
      name: "graphify",
      kind: "mcp",
      source: "https://api.graphify.com/mcp",
      purpose: "Repository graph analysis",
      confirmed: true,
    });

    await expect(verifyPendingExtensionOAuth("ses-oauth-check")).resolves.toEqual({
      status: "ready",
      extension,
    });
    expect(getPendingExtensionOAuth("ses-oauth-check")).toBeNull();
    expect(mocks.generateActions).toHaveBeenCalledWith(extension);
  });

  it("auto-generates Actions after OAuth completes", async () => {
    mocks.createMcp.mockResolvedValue({
      name: "graphify",
      type: "remote",
      status: { status: "needs_auth" },
    });
    mocks.startOAuth.mockResolvedValue({
      authorizationUrl: "https://graphify.example/oauth/authorize",
      oauthState: "oauth-state",
    });
    const extension = {
      id: "mcp:graphify",
      name: "graphify",
      kind: "mcp",
      source: "https://api.graphify.com/mcp",
      purpose: "Repository graph analysis",
      authType: "oauth",
      credentialSchemas: [],
      resource: { kind: "mcp", serverName: "graphify", projectDirectory: "/work/repo" },
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
      managed: true,
    };
    mocks.getExtension.mockResolvedValue(extension);

    await addMcpBackedExtension({
      sessionId: "ses-oauth-complete",
      projectDirectory: "/work/repo",
      name: "graphify",
      kind: "mcp",
      source: "https://api.graphify.com/mcp",
      purpose: "Repository graph analysis",
      confirmed: true,
    });

    await expect(
      completeExtensionOAuth(
        "ses-oauth-complete",
        "http://localhost/callback?code=abc&state=oauth-state",
      ),
    ).resolves.toEqual(extension);
    expect(mocks.completeOAuth).toHaveBeenCalledWith("/work/repo", "graphify", "abc");
    expect(mocks.generateActions).toHaveBeenCalledWith(extension);
  });

  it("uses secure credential input when API-key auth is selected", async () => {
    mocks.createMcp.mockResolvedValue({
      name: "private-mcp",
      type: "remote",
      status: { status: "needs_auth" },
    });

    const result = await addMcpBackedExtension({
      sessionId: "ses-key",
      projectDirectory: "/work/repo",
      name: "private-mcp",
      kind: "mcp",
      source: "https://mcp.example.com/mcp",
      purpose: "Private tools",
      confirmed: true,
      authType: "api-key",
    });

    expect(result).toMatchObject({
      status: "awaiting-credential",
      challengeId: "challenge-1",
      credentialId: "api-key",
    });
    expect(mocks.startOAuth).not.toHaveBeenCalled();
    expect(mocks.createChallenge).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "ses-key",
      credentialId: "api-key",
    }));
  });

  it("auto-generates Actions after secure API-key validation", async () => {
    const extension = {
      id: "mcp:private-mcp",
      name: "private-mcp",
      kind: "mcp",
      source: "https://mcp.example.com/mcp",
      purpose: "Private tools",
      authType: "api-key",
      credentialSchemas: [{
        id: "api-key",
        label: "API key",
        type: "api-key",
        transport: { kind: "api-key-header" },
      }],
      resource: { kind: "mcp", serverName: "private-mcp", projectDirectory: "/work/repo" },
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
      managed: true,
    };
    mocks.getExtension.mockResolvedValue(extension);

    await expect(finalizeExtensionCredential("mcp:private-mcp")).resolves.toEqual(extension);
    expect(mocks.configureSecure).toHaveBeenCalledWith({
      projectDirectory: "/work/repo",
      serverName: "private-mcp",
      remoteUrl: "https://mcp.example.com/mcp",
      mode: "api-key",
      headerName: "X-API-Key",
      secret: "secret-value",
    });
    expect(mocks.generateActions).toHaveBeenCalledWith(extension);
  });

  it("previews a Skill, then imports it and auto-generates its Action after confirmation", async () => {
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
    expect(preview).toMatchObject({
      status: "question-required",
      kind: "skill",
      preview: { name: "deploy-check" },
      questionTool: {
        tool: "question",
        arguments: {
          questions: [{
            header: "Add Skill",
            multiple: false,
          }],
        },
      },
    });
    expect(mocks.writeSkill).not.toHaveBeenCalled();

    const installed = await addSkillExtension({
      sessionId: "ses-skill",
      projectDirectory: "/work/repo",
      source: "https://github.com/example/skills/tree/main/deploy-check",
      confirmed: true,
    });
    expect(installed).toMatchObject({
      status: "ready",
      extension: { id: "skill:deploy-check", kind: "skill" },
    });
    expect(mocks.writeSkill).toHaveBeenCalledWith("deploy-check", "# Deploy check");
    expect(mocks.generateActions).toHaveBeenCalledWith(expect.objectContaining({
      id: "skill:deploy-check",
    }));
  });
});
