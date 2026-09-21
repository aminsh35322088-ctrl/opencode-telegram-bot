import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: {
    todo: vi.fn(), diff: vi.fn(), children: vi.fn(), fork: vi.fn(), revert: vi.fn(), unrevert: vi.fn(), summarize: vi.fn(), abort: vi.fn(),
  },
  current: vi.fn(),
  model: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({ opencodeClient: { session: mocks.session } }));
vi.mock("../../../src/app/services/session-service.js", () => ({ getEffectiveCurrentSession: mocks.current }));
vi.mock("../../../src/app/services/model-selection-service.js", () => ({ getStoredModel: mocks.model }));

import {
  abortCurrentSession,
  forkCurrentSession,
  listSessionDiff,
  revertCurrentSession,
  summarizeCurrentSession,
} from "../../../src/app/services/session-autonomy-service.js";

describe("session autonomy service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.current.mockResolvedValue({ id: "ses-1", title: "Topic", directory: "/repo" });
    mocks.model.mockReturnValue({ providerID: "openai", modelID: "gpt-5", variant: "default" });
    for (const method of Object.values(mocks.session)) method.mockResolvedValue({ data: { ok: true }, error: null });
  });

  it("reads diff in the exact current session scope", async () => {
    await listSessionDiff();
    expect(mocks.session.diff).toHaveBeenCalledWith({ sessionID: "ses-1", directory: "/repo" });
  });

  it("requires an explicit message id for fork/revert callers and forwards it exactly", async () => {
    await forkCurrentSession("msg-7");
    await revertCurrentSession("msg-8");
    expect(mocks.session.fork).toHaveBeenCalledWith({ sessionID: "ses-1", messageID: "msg-7", directory: "/repo" });
    expect(mocks.session.revert).toHaveBeenCalledWith({ sessionID: "ses-1", messageID: "msg-8", directory: "/repo" });
  });

  it("summarizes with the currently selected concrete model", async () => {
    await summarizeCurrentSession();
    expect(mocks.session.summarize).toHaveBeenCalledWith({ sessionID: "ses-1", directory: "/repo", providerID: "openai", modelID: "gpt-5" });
  });

  it("propagates OpenCode action failures instead of pretending success", async () => {
    mocks.session.abort.mockResolvedValueOnce({ data: undefined, error: new Error("abort failed") });
    await expect(abortCurrentSession()).rejects.toThrow("abort failed");
  });
});