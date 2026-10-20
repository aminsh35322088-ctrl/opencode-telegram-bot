import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

const { get, abort, create, prompt, remove, listBindings, findTopic, downloadRemote } = vi.hoisted(() => ({
  get: vi.fn(),
  abort: vi.fn(),
  create: vi.fn(),
  prompt: vi.fn(),
  remove: vi.fn(),
  listBindings: vi.fn(),
  findTopic: vi.fn(),
  downloadRemote: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      get,
      abort,
      create,
      prompt,
      delete: remove,
    },
  },
}));


vi.mock("../../../src/control-plane/node-bindings.js", () => ({ nodeBindings: { list: listBindings } }));
vi.mock("../../../src/app/services/telegram-topic-store.js", () => ({ findTelegramTopicBindingByThread: findTopic }));
vi.mock("../../../src/app/services/remote-worker-file-service.js", () => ({ downloadRemoteWorkerFile: downloadRemote }));

import { runOpenCodeImageModel } from "../../../src/app/services/opencode-image-execution-service.js";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const selection = { providerID: "google", modelID: "image-model" };
const worktree = path.resolve("/tmp/project");
const owner = { sessionId: "parent", directory: worktree };

describe("generic OpenCode image execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    get.mockResolvedValue({ data: { id: owner.sessionId, directory: worktree } });
    abort.mockResolvedValue({ data: true });
    create.mockResolvedValue({ data: { id: "image-session", parentID: owner.sessionId, directory: worktree }, error: null });
    remove.mockResolvedValue({ data: true, error: null });
    listBindings.mockResolvedValue([{ nodeId: "node-1", chatId: -100123, threadId: 44, generation: 3, status: "ready", sessionId: owner.sessionId }]);
    findTopic.mockResolvedValue({ chatId: -100123, threadId: 44, sessionId: owner.sessionId, directory: worktree });
    prompt.mockResolvedValue({
      data: {
        info: { id: "assistant" },
        parts: [
          {
            id: "file-1",
            type: "file",
            mime: "image/png",
            url: "data:image/png;base64," + PNG.toString("base64"),
          },
        ],
      },
      error: null,
    });
  });

  it("pins the selected provider/model and returns an image FilePart", async () => {
    const result = await runOpenCodeImageModel(
      selection,
      "draw a lighthouse",
      undefined,
      new AbortController().signal,
      worktree,
      owner,
    );

    expect(result.mimeType).toBe("image/png");
    expect(result.buffer.equals(PNG)).toBe(true);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      directory: worktree,
      parentID: owner.sessionId,
      model: { providerID: "google", id: "image-model" },
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "image-session",
        directory: worktree,
        model: selection,
      }),
      expect.anything(),
    );
    expect(remove).toHaveBeenCalledWith({
      sessionID: "image-session",
      directory: worktree,
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(abort).toHaveBeenCalledWith({ sessionID: "image-session", directory: worktree }, expect.anything());
  });

  it("downloads file-part image output from the owning remote Worker instead of reading its path locally", async () => {
    const remotePath = path.join(worktree, "artifacts", "image-result.png");
    const temporary = path.join(os.tmpdir(), `remote-image-${Date.now()}.png`);
    await fs.writeFile(temporary, PNG);
    downloadRemote.mockResolvedValue({ path: temporary, cleanup: async () => { await fs.rm(temporary, { force: true }); } });
    prompt.mockResolvedValueOnce({ data: { info: { id: "assistant" }, parts: [{ id: "file-remote", type: "file", mime: "image/png", url: new URL(`file://${remotePath}`).href }] }, error: null });
    const result = await runOpenCodeImageModel(selection, "draw a cat", undefined, new AbortController().signal, worktree, owner);
    expect(result.buffer).toEqual(PNG);
    expect(downloadRemote).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "node-1", sessionId: owner.sessionId }), remotePath);
    expect(findTopic).toHaveBeenCalledWith(-100123, 44);
  });

  it("attaches the reference image for image-edit capable models", async () => {
    await runOpenCodeImageModel(
      selection,
      "make it warmer",
      { buffer: PNG, mimeType: "image/png" },
      new AbortController().signal,
      worktree,
      owner,
    );

    const request = prompt.mock.calls[0]![0];
    expect(request.parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "file",
        mime: "image/png",
        url: expect.stringMatching(/^data:image\/png;base64,/),
      }),
    ]));
  });

  it("fails explicitly when a selected model returns no image", async () => {
    prompt.mockResolvedValueOnce({
      data: { info: { id: "assistant" }, parts: [{ type: "text", text: "no image" }] },
      error: null,
    });

    await expect(runOpenCodeImageModel(
      selection,
      "draw it",
      undefined,
      new AbortController().signal,
      worktree,
      owner,
    )).rejects.toThrow("returned no image output");

    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("rejects missing or mismatched owner before creating an image session", async () => {
    await expect(runOpenCodeImageModel(selection, "draw", undefined, new AbortController().signal, worktree)).rejects.toThrow("parent session");
    await expect(runOpenCodeImageModel(selection, "draw", undefined, new AbortController().signal, worktree, { ...owner, directory: path.resolve("/other") })).rejects.toThrow("Topic worktree");
    expect(create).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });
});
