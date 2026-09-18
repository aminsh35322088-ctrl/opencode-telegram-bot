import { beforeEach, describe, expect, it, vi } from "vitest";

const { readAppState, listTopicRuntimeStates } = vi.hoisted(() => ({
  readAppState: vi.fn(),
  listTopicRuntimeStates: vi.fn(),
}));

vi.mock("../../../src/app/stores/app-state-store.js", () => ({ readAppState }));
vi.mock("../../../src/app/stores/topic-runtime-state-store.js", () => ({ listTopicRuntimeStates }));

import { resolvePersistedImageModel } from "../../../src/app/services/image-model-resolution-service.js";

describe("image model persisted resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readAppState.mockResolvedValue({
      version: 2,
      settings: {
        defaultImageModel: {
          providerID: "global-images",
          modelID: "global-model",
          editModelID: "global-model",
        },
      },
    });
    listTopicRuntimeStates.mockResolvedValue([]);
  });

  it("uses the Main Default when no Topic matches the worktree", async () => {
    expect(await resolvePersistedImageModel("/work/a")).toEqual({
      providerID: "global-images",
      modelID: "global-model",
      editModelID: "global-model",
    });
  });

  it("uses a matching Topic override ahead of the Main Default", async () => {
    listTopicRuntimeStates.mockResolvedValue([
      {
        chatId: 1,
        threadId: 2,
        settings: {
          workspaceDirectory: "/work/topic-a",
          imageModelOverride: {
            providerID: "topic-images",
            modelID: "topic-model",
            editModelID: "topic-model",
          },
        },
      },
    ]);

    expect(await resolvePersistedImageModel("/work/topic-a")).toEqual({
      providerID: "topic-images",
      modelID: "topic-model",
      editModelID: "topic-model",
    });
  });
});
