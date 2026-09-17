import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Context } from "grammy";

const mocked = vi.hoisted(() => ({
  sessionStatus: vi.fn(),
  questionList: vi.fn(),
  permissionList: vi.fn(),
  setSession: vi.fn(),
  setBotAndChatId: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: { status: mocked.sessionStatus },
    question: { list: mocked.questionList },
    permission: { list: mocked.permissionList },
  },
}));

vi.mock("../../../src/app/managers/summary-aggregation-manager.js", () => ({
  summaryAggregator: {
    setSession: mocked.setSession,
    setBotAndChatId: mocked.setBotAndChatId,
    clear: vi.fn(),
  },
}));

vi.mock("../../../src/app/services/session-service.js", () => ({
  getCurrentSession: vi.fn(() => null),
  clearSession: vi.fn(),
}));

vi.mock("../../../src/app/stores/settings-store.js", () => ({
  getCurrentProject: vi.fn(() => null),
  getCurrentModel: vi.fn(() => undefined),
}));

vi.mock("../../../src/opencode/ready-refresh.js", () => ({
  isOpencodeServerHealthy: vi.fn(async () => true),
}));

import {
  attachToSession,
  configureAttachPresentation,
} from "../../../src/app/services/attach-service.js";
import { attachManager } from "../../../src/app/managers/attach-manager.js";

const session = {
  id: "session-1",
  title: "Session One",
  directory: "/workspace/project",
};

const bot = { api: {} } as unknown as Bot<Context>;

async function attach() {
  return attachToSession({
    bot,
    chatId: 777,
    session,
    ensureEventSubscription: vi.fn().mockResolvedValue(undefined),
  });
}

describe("attach/service liveness", () => {
  beforeEach(() => {
    attachManager.__resetForTests();
    configureAttachPresentation(null);
    mocked.sessionStatus.mockReset();
    mocked.questionList.mockReset();
    mocked.permissionList.mockReset();
    mocked.questionList.mockResolvedValue({ data: [], error: null });
    mocked.permissionList.mockResolvedValue({ data: [], error: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats OpenCode retry state as busy", async () => {
    mocked.sessionStatus.mockResolvedValue({
      data: { "session-1": { type: "retry" } },
      error: null,
    });

    const result = await attach();

    expect(result.busy).toBe(true);
    expect(attachManager.getSnapshot()).toMatchObject({
      sessionId: "session-1",
      busy: true,
    });
  });

  it("bounds a hanging OpenCode status lookup instead of freezing attach", async () => {
    vi.useFakeTimers();
    mocked.sessionStatus.mockImplementation(
      (_params: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new Error("status probe aborted")),
            { once: true },
          );
        }),
    );

    const resultPromise = attach();
    await vi.advanceTimersByTimeAsync(3500);
    const result = await resultPromise;

    expect(result.busy).toBe(false);
    expect(mocked.sessionStatus).toHaveBeenCalledTimes(1);
  });
});
