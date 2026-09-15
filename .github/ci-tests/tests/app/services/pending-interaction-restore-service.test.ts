import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listBindings: vi.fn(),
  questionList: vi.fn(),
  permissionList: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    question: { list: mocks.questionList },
    permission: { list: mocks.permissionList },
  },
}));

vi.mock("../../../src/app/services/telegram-topic-store.js", () => ({
  listTelegramTopicBindings: mocks.listBindings,
}));

import { restorePendingInteractions, type PendingInteractionPresenters } from "../../../src/app/services/pending-interaction-restore-service.js";

const binding = {
  chatId: 100,
  threadId: 50,
  sessionId: "session-1",
  directory: "/work/topic-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function presenters(): PendingInteractionPresenters & {
  presentQuestion: ReturnType<typeof vi.fn>;
  presentPermission: ReturnType<typeof vi.fn>;
} {
  return { presentQuestion: vi.fn(async () => {}), presentPermission: vi.fn(async () => {}) };
}

describe("restorePendingInteractions", () => {
  beforeEach(() => {
    mocks.listBindings.mockResolvedValue([binding]);
    mocks.questionList.mockResolvedValue({ data: [], error: undefined });
    mocks.permissionList.mockResolvedValue({ data: [], error: undefined });
  });

  it("re-presents a pending question for its own session inside the Topic context", async () => {
    mocks.questionList.mockResolvedValue({
      data: [{ id: "req-1", sessionID: "session-1", questions: [{ question: "A?", header: "h", options: [] }] }],
      error: undefined,
    });
    const presentersMock = presenters();

    await restorePendingInteractions(presentersMock);

    expect(presentersMock.presentQuestion).toHaveBeenCalledWith("session-1", "req-1", [
      { question: "A?", header: "h", options: [] },
    ]);
    expect(presentersMock.presentPermission).not.toHaveBeenCalled();
  });

  it("ignores pending requests that belong to a different session", async () => {
    mocks.questionList.mockResolvedValue({
      data: [{ id: "req-x", sessionID: "other", questions: [] }],
      error: undefined,
    });
    mocks.permissionList.mockResolvedValue({
      data: [{ id: "perm-x", sessionID: "other", permission: "bash", patterns: [], metadata: {}, always: [] }],
      error: undefined,
    });
    const presentersMock = presenters();

    await restorePendingInteractions(presentersMock);

    expect(presentersMock.presentQuestion).not.toHaveBeenCalled();
    expect(presentersMock.presentPermission).not.toHaveBeenCalled();
  });

  it("re-presents pending permissions", async () => {
    const permission = { id: "perm-1", sessionID: "session-1", permission: "edit", patterns: ["/x"], metadata: {}, always: [] };
    mocks.permissionList.mockResolvedValue({ data: [permission], error: undefined });
    const presentersMock = presenters();

    await restorePendingInteractions(presentersMock);

    expect(presentersMock.presentPermission).toHaveBeenCalledTimes(1);
    expect(presentersMock.presentPermission.mock.calls[0][0]).toMatchObject({ id: "perm-1" });
  });

  it("continues to the next Topic when one binding throws", async () => {
    mocks.listBindings.mockResolvedValue([
      binding,
      { ...binding, chatId: 200, threadId: 60, sessionId: "session-2", directory: "/work/topic-2" },
    ]);
    const permission = { id: "perm-2", sessionID: "session-2", permission: "edit", patterns: [], metadata: {}, always: [] };
    mocks.permissionList.mockImplementation(async ({ directory }: { directory: string }) => {
      if (directory === "/work/topic-1") throw new Error("boom");
      return { data: [permission], error: undefined };
    });
    const presentersMock = presenters();

    await restorePendingInteractions(presentersMock);

    expect(presentersMock.presentPermission).toHaveBeenCalledTimes(1);
    expect(presentersMock.presentPermission.mock.calls[0][0]).toMatchObject({ id: "perm-2" });
  });

  it("is a no-op when there are no bindings", async () => {
    mocks.listBindings.mockResolvedValue([]);
    const presentersMock = presenters();

    await restorePendingInteractions(presentersMock);

    expect(mocks.questionList).not.toHaveBeenCalled();
    expect(presentersMock.presentQuestion).not.toHaveBeenCalled();
  });
});
