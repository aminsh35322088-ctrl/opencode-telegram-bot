import { beforeEach, describe, expect, it, vi } from "vitest";
import { runImageChatEngine } from "../../../src/app/services/image-chat-engine.js";
import { readBoundedJson, validateImage } from "../../../src/app/services/ai-http-service.js";
import type { ImageChatProfile, ImageChatTurn } from "../../../src/app/types/image-chat.js";

const imageTool = vi.hoisted(() => vi.fn());
vi.mock("../../../src/app/services/image-chat-profile-service.js", () => ({
  validateImageChatProfile: vi.fn(async () => {}),
  resolveImageChatConnection: vi.fn(async () => ({ apiKey: "secret", endpoint: "https://example.test/v1" })),
}));
vi.mock("../../../src/app/services/image-ai-provider-service.js", () => ({ runImageForChat: imageTool }));
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
const profile: ImageChatProfile = { mode: "gemini", connectionID: "test", modelID: "chosen-model", endpoint: "https://example.test/v1" };
const reference = { fileID: "telegram-ref", mimeType: "image/png" };
const load = vi.fn();
const request = vi.fn();
beforeEach(() => { request.mockReset(); load.mockReset(); imageTool.mockReset(); vi.stubGlobal("fetch", request); load.mockResolvedValue({ buffer: png, mimeType: "image/png" }); imageTool.mockResolvedValue({ buffer: png, mimeType: "image/png" }); });
const signal = () => new AbortController().signal;
const turns: ImageChatTurn[] = [{ role: "user", parts: [{ text: "edit this" }] }];
function reply(content: string) { request.mockImplementation(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }))); }

describe("Image Chat protocol boundaries", () => {
  it("replays native image parts and thought signatures without flattening them", async () => {
    request.mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "result", thoughtSignature: "new-text-signature" }, { inlineData: { data: png.toString("base64"), mimeType: "image/png" }, thoughtSignature: "new-image-signature" }] } }] })));
    const history: ImageChatTurn[] = [{ role: "model", parts: [{ text: "earlier", thoughtSignature: "text-signature" }, { image: reference, thoughtSignature: "image-signature" }] }, ...turns];
    const result = await runImageChatEngine(profile, history, reference, load, signal());
    const body = JSON.parse(request.mock.calls[0]![1].body);
    expect(request.mock.calls[0]![0]).toContain("chosen-model:generateContent");
    expect(body.contents[0].parts).toEqual([{ text: "earlier", thoughtSignature: "text-signature" }, { inlineData: { data: png.toString("base64"), mimeType: "image/png" }, thoughtSignature: "image-signature" }]);
    expect(body.generationConfig.responseModalities).toEqual(["TEXT", "IMAGE"]);
    expect(result[1]?.thoughtSignature).toBe("new-image-signature"); expect(result[1]?.image?.buffer).toEqual(png);
    expect(imageTool).not.toHaveBeenCalled();
  });
  it.each(["not JSON", '{"operation":"generate","reply":"ok"}', '{"operation":"unknown","reply":"ok"}'])("does not infer an image operation from invalid output: %s", async content => {
    reply(content); const result = await runImageChatEngine({ ...profile, mode: "tools" }, turns, reference, load, signal());
    expect(result[0]?.text).toContain("couldn't interpret"); expect(imageTool).not.toHaveBeenCalled();
  });
  it("keeps design discussion as text without generating images", async () => {
    reply('{"operation":"chat","reply":"Which colors do you like?"}');
    expect(await runImageChatEngine({ ...profile, mode: "tools" }, turns, undefined, load, signal())).toEqual([{ text: "Which colors do you like?" }]);
    expect(imageTool).not.toHaveBeenCalled();
  });
  it("requires an actual reference for editing", async () => {
    reply('{"operation":"edit","reply":"ok","instruction":"make it blue"}');
    await runImageChatEngine({ ...profile, mode: "tools" }, turns, undefined, load, signal());
    expect(imageTool).not.toHaveBeenCalled();
    await runImageChatEngine({ ...profile, mode: "tools" }, turns, reference, load, signal());
    expect(imageTool).toHaveBeenCalledWith(expect.objectContaining({ mode: "tools" }), "make it blue", { buffer: png, mimeType: "image/png" }, expect.any(AbortSignal));
  });
  it("never retries inference or switches engines after provider failure", async () => {
    request.mockResolvedValue(new Response("private-provider-error", { status: 429 }));
    await expect(runImageChatEngine(profile, turns, undefined, load, signal())).rejects.toThrow("HTTP 429");
    expect(request).toHaveBeenCalledOnce(); expect(imageTool).not.toHaveBeenCalled();
  });
  it("does not call an image tool after cancellation", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(runImageChatEngine({ ...profile, mode: "tools" }, turns, reference, load, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(request).not.toHaveBeenCalled(); expect(imageTool).not.toHaveBeenCalled();
  });
  it("bounds response bytes and validates image signatures", async () => {
    await expect(readBoundedJson(new Response(" ".repeat(100)), 10)).rejects.toThrow("size limit");
    expect(() => validateImage(Buffer.from("<html>error</html>"), "image/png")).toThrow("valid PNG");
    expect(() => validateImage(png, "image/png")).not.toThrow();
    expect(() => validateImage(Buffer.alloc(8 * 1024 * 1024 + 1), "image/png")).toThrow("under 8 MB");
  });
});
