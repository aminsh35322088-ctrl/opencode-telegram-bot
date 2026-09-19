import { beforeEach, describe, expect, it, vi } from "vitest";

const { create, prompt, remove } = vi.hoisted(() => ({
  create: vi.fn(),
  prompt: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("../../../src/opencode/client.js", () => ({
  opencodeClient: {
    session: {
      create,
      prompt,
      delete: remove,
    },
  },
}));

import { runOpenCodeImageModel } from "../../../src/app/services/opencode-image-execution-service.js";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const selection = { providerID: "google", modelID: "image-model" };

describe("generic OpenCode image execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    create.mockResolvedValue({ data: { id: "image-session" }, error: null });
    remove.mockResolvedValue({ data: true, error: null });
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
      "/tmp/project",
    );

    expect(result.mimeType).toBe("image/png");
    expect(result.buffer.equals(PNG)).toBe(true);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      directory: "/tmp/project",
      model: { providerID: "google", id: "image-model" },
    }));
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionID: "image-session",
        directory: "/tmp/project",
        model: selection,
      }),
      expect.anything(),
    );
    expect(remove).toHaveBeenCalledWith({
      sessionID: "image-session",
      directory: "/tmp/project",
    });
  });

  it("attaches the reference image for image-edit capable models", async () => {
    await runOpenCodeImageModel(
      selection,
      "make it warmer",
      { buffer: PNG, mimeType: "image/png" },
      new AbortController().signal,
      "/tmp/project",
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
      "/tmp/project",
    )).rejects.toThrow("returned no image output");

    expect(remove).toHaveBeenCalledTimes(1);
  });
});