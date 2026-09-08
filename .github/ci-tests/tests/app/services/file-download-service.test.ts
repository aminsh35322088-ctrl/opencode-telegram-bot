import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Api } from "grammy";
import { Agent as HttpsAgent } from "https";
import {
  toDataUri,
  formatFileSize,
  isFileSizeAllowed,
  isTextFileName,
  isTextMimeType,
} from "../../../src/app/services/file-download-service.js";
import { defined } from "../../helpers/defined.js";

const nodeFetchMock = vi.hoisted(() => vi.fn());

// config.ts is fully hardcoded; telegram wiring values are injected via this
// mutable mock instead of environment variables.
const configMock = vi.hoisted(() => ({
  telegram: {
    token: "bot-token-xyz",
    allowedUserId: 123456789,
    proxyUrl: "",
    apiRoot: "",
    proxySecret: "",
    forceIpv4: false,
  },
  // Minimal stubs for properties that other modules read at import time
  // (e.g., opencode/client.ts reads config.opencode during module init).
  opencode: {
    apiUrl: "http://localhost:4096",
    username: "opencode",
    password: "",
    model: { provider: "test", modelId: "test" },
  },
  server: { logLevel: "error" },
  bot: {
    sessionsListLimit: 10,
    projectsListLimit: 10,
    locale: "en",
  },
  files: { maxFileSizeKb: 100 },
  stt: { apiUrl: "", apiKey: "", model: "whisper-large-v3-turbo", language: "", requestFormat: "multipart" },
}));

vi.mock("node-fetch", () => ({
  default: nodeFetchMock,
}));

vi.mock("../../../src/config.js", () => ({
  config: configMock,
}));

describe("app/services/file-download-service", () => {
  describe("toDataUri", () => {
    it("converts buffer to base64 data URI with correct MIME type", () => {
      const buffer = Buffer.from("Hello, World!");
      const dataUri = toDataUri(buffer, "text/plain");

      expect(dataUri).toBe("data:text/plain;base64,SGVsbG8sIFdvcmxkIQ==");
    });

    it("handles image MIME types", () => {
      const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic number
      const dataUri = toDataUri(buffer, "image/png");

      expect(dataUri).toMatch(/^data:image\/png;base64,/);
      expect(dataUri).toBe("data:image/png;base64,iVBORw==");
    });

    it("handles empty buffer", () => {
      const buffer = Buffer.from([]);
      const dataUri = toDataUri(buffer, "application/octet-stream");

      expect(dataUri).toBe("data:application/octet-stream;base64,");
    });
  });

  describe("isFileSizeAllowed", () => {
    it("returns true when file size is within limit", () => {
      expect(isFileSizeAllowed(100 * 1024, 200)).toBe(true); // 100KB < 200KB
      expect(isFileSizeAllowed(1024, 1)).toBe(true); // exactly at limit
    });

    it("returns false when file size exceeds limit", () => {
      expect(isFileSizeAllowed(300 * 1024, 200)).toBe(false); // 300KB > 200KB
      expect(isFileSizeAllowed(1025, 1)).toBe(false); // just over limit
    });

    it("returns true when file size is undefined (unknown)", () => {
      expect(isFileSizeAllowed(undefined, 100)).toBe(true);
    });
  });

  describe("formatFileSize", () => {
    it("formats bytes correctly", () => {
      expect(formatFileSize(0)).toBe("0B");
      expect(formatFileSize(500)).toBe("500B");
      expect(formatFileSize(1023)).toBe("1023B");
    });

    it("formats kilobytes correctly", () => {
      expect(formatFileSize(1024)).toBe("1.0KB");
      expect(formatFileSize(1536)).toBe("1.5KB");
      expect(formatFileSize(10240)).toBe("10.0KB");
    });

    it("formats megabytes correctly", () => {
      expect(formatFileSize(1024 * 1024)).toBe("1.0MB");
      expect(formatFileSize(2.5 * 1024 * 1024)).toBe("2.5MB");
      expect(formatFileSize(10 * 1024 * 1024)).toBe("10.0MB");
    });
  });

  describe("isTextMimeType", () => {
    it("returns true for text/* MIME types", () => {
      expect(isTextMimeType("text/plain")).toBe(true);
      expect(isTextMimeType("text/markdown")).toBe(true);
      expect(isTextMimeType("text/html")).toBe(true);
      expect(isTextMimeType("text/css")).toBe(true);
      expect(isTextMimeType("text/javascript")).toBe(true);
      expect(isTextMimeType("text/x-python")).toBe(true);
      expect(isTextMimeType("text/csv")).toBe(true);
    });

    it("returns true for whitelisted application/* types", () => {
      expect(isTextMimeType("application/json")).toBe(true);
      expect(isTextMimeType("application/xml")).toBe(true);
      expect(isTextMimeType("application/javascript")).toBe(true);
      expect(isTextMimeType("application/x-yaml")).toBe(true);
      expect(isTextMimeType("application/sql")).toBe(true);
    });

    it("returns false for other application/* types", () => {
      expect(isTextMimeType("application/pdf")).toBe(false);
      expect(isTextMimeType("application/zip")).toBe(false);
      expect(isTextMimeType("application/octet-stream")).toBe(false);
      expect(isTextMimeType("application/msword")).toBe(false);
    });

    it("returns false for image/* types", () => {
      expect(isTextMimeType("image/png")).toBe(false);
      expect(isTextMimeType("image/jpeg")).toBe(false);
      expect(isTextMimeType("image/gif")).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isTextMimeType(undefined)).toBe(false);
    });

    it("returns false for empty string", () => {
      expect(isTextMimeType("")).toBe(false);
    });

    it("returns true for unknown MIME with known code file extension", () => {
      expect(isTextMimeType("application/octet-stream", "component.svelte")).toBe(true);
      expect(isTextMimeType("application/octet-stream", "App.vue")).toBe(true);
      expect(isTextMimeType("application/octet-stream", "main.tsx")).toBe(true);
      expect(isTextMimeType("application/octet-stream", "server.go")).toBe(true);
      expect(isTextMimeType("application/octet-stream", "script.py")).toBe(true);
    });

    it("returns false for unknown MIME with unknown extension", () => {
      expect(isTextMimeType("application/octet-stream", "file.xyz")).toBe(false);
      expect(isTextMimeType("application/octet-stream", "archive.7z")).toBe(false);
    });

    it("returns false for unknown MIME without filename", () => {
      expect(isTextMimeType("application/octet-stream")).toBe(false);
    });

    it("returns false for undefined MIME even with known extension", () => {
      expect(isTextMimeType(undefined, "file.svelte")).toBe(false);
    });

    it("handles files with multiple dots correctly", () => {
      expect(isTextMimeType("application/octet-stream", "Component.test.svelte")).toBe(true);
      expect(isTextMimeType("application/octet-stream", "some.file.with.dots.py")).toBe(true);
    });

    it("handles files with no extension", () => {
      expect(isTextMimeType("application/octet-stream", "Dockerfile")).toBe(false);
    });
  });

  describe("isTextFileName", () => {
    it("accepts source files by extension", () => {
      expect(isTextFileName("index.ts")).toBe(true);
      expect(isTextFileName("app.js")).toBe(true);
      expect(isTextFileName("package.json")).toBe(true);
      expect(isTextFileName("notes.txt")).toBe(true);
      expect(isTextFileName("main.py")).toBe(true);
    });

    it("accepts known extensionless files and dotfiles", () => {
      expect(isTextFileName("Makefile")).toBe(true);
      expect(isTextFileName("Dockerfile")).toBe(true);
      expect(isTextFileName(".env.example")).toBe(true);
      expect(isTextFileName(".gitignore")).toBe(true);
    });

    it("is case-insensitive for extensionless names", () => {
      expect(isTextFileName("MAKEFILE")).toBe(true);
      expect(isTextFileName("dockerfile")).toBe(true);
    });

    it("accepts a full path by looking only at the base name", () => {
      expect(isTextFileName("D:\\Repo\\src\\bot\\index.ts")).toBe(true);
      expect(isTextFileName("/repo/src/Makefile")).toBe(true);
    });

    it("rejects binary files", () => {
      expect(isTextFileName("logo.png")).toBe(false);
      expect(isTextFileName("app.exe")).toBe(false);
      expect(isTextFileName("archive.zip")).toBe(false);
      expect(isTextFileName("doc.pdf")).toBe(false);
    });

    it("rejects unknown extensionless files", () => {
      expect(isTextFileName("mystery")).toBe(false);
      expect(isTextFileName("")).toBe(false);
    });
  });
});

describe("downloadTelegramFile reverse-proxy wiring", () => {
  beforeEach(() => {
    configMock.telegram.token = "bot-token-xyz";
    configMock.telegram.allowedUserId = 123456789;
    configMock.telegram.proxyUrl = "";
    configMock.telegram.apiRoot = "";
    configMock.telegram.proxySecret = "";
    configMock.telegram.forceIpv4 = false;
    nodeFetchMock.mockReset();
  });

  function makeApiStub(): Api {
    return {
      getFile: vi.fn().mockResolvedValue({
        file_path: "voice/sample.ogg",
        file_size: 100,
      }),
    } as unknown as Api;
  }

  function makeFetchStub(): ReturnType<typeof vi.fn> {
    return nodeFetchMock.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });
  }

  async function loadDownloadModule() {
    vi.resetModules();
    return import("../../../src/app/services/file-download-service.js");
  }

  it("uses api.telegram.org as the file URL base when apiRoot is not set", async () => {
    configMock.telegram.apiRoot = "";
    const fetchMock = makeFetchStub();
    vi.stubGlobal("fetch", fetchMock);

    const { downloadTelegramFile } = await loadDownloadModule();
    await downloadTelegramFile(makeApiStub(), "fid");

    const call = defined(fetchMock.mock.calls[0]);
    const [url] = call;
    expect(url).toBe("https://api.telegram.org/file/botbot-token-xyz/voice/sample.ogg");
  });

  it("uses config.telegram.apiRoot as the file URL base when set", async () => {
    configMock.telegram.apiRoot = "https://tg-proxy.example.com";
    const fetchMock = makeFetchStub();
    vi.stubGlobal("fetch", fetchMock);

    const { downloadTelegramFile } = await loadDownloadModule();
    await downloadTelegramFile(makeApiStub(), "fid");

    const call = defined(fetchMock.mock.calls[0]);
    const [url] = call;
    expect(url).toBe("https://tg-proxy.example.com/file/botbot-token-xyz/voice/sample.ogg");
  });

  it("normalizes a trailing slash so the URL has no double slash", async () => {
    configMock.telegram.apiRoot = "https://tg-proxy.example.com/";
    const fetchMock = makeFetchStub();
    vi.stubGlobal("fetch", fetchMock);

    const { downloadTelegramFile } = await loadDownloadModule();
    await downloadTelegramFile(makeApiStub(), "fid");

    const call = defined(fetchMock.mock.calls[0]);
    const [url] = call;
    expect(url).toBe("https://tg-proxy.example.com/file/botbot-token-xyz/voice/sample.ogg");
  });

  it("does not send X-Proxy-Secret when proxySecret is unset", async () => {
    configMock.telegram.apiRoot = "https://tg-proxy.example.com";
    configMock.telegram.proxySecret = "";
    const fetchMock = makeFetchStub();
    vi.stubGlobal("fetch", fetchMock);

    const { downloadTelegramFile } = await loadDownloadModule();
    await downloadTelegramFile(makeApiStub(), "fid");

    const call = defined(fetchMock.mock.calls[0]);
    const [, init] = call;
    const headers = (init as { headers?: Record<string, string> } | undefined)?.headers;
    expect(headers?.["X-Proxy-Secret"]).toBeUndefined();
  });

  it("sends X-Proxy-Secret on the file fetch when proxySecret is set", async () => {
    configMock.telegram.apiRoot = "https://tg-proxy.example.com";
    configMock.telegram.proxySecret = "secret-abc";
    const fetchMock = makeFetchStub();
    vi.stubGlobal("fetch", fetchMock);

    const { downloadTelegramFile } = await loadDownloadModule();
    await downloadTelegramFile(makeApiStub(), "fid");

    const call = defined(fetchMock.mock.calls[0]);
    const [, init] = call;
    const headers = (init as { headers?: Record<string, string> } | undefined)?.headers;
    expect(headers?.["X-Proxy-Secret"]).toBe("secret-abc");
  });

  it("does not configure a fetch agent for direct downloads by default", async () => {
    const fetchMock = makeFetchStub();
    vi.stubGlobal("fetch", fetchMock);

    const { downloadTelegramFile } = await loadDownloadModule();
    await downloadTelegramFile(makeApiStub(), "fid");

    const call = defined(fetchMock.mock.calls[0]);
    const [, init] = call;
    expect((init as { agent?: unknown } | undefined)?.agent).toBeUndefined();
  });

  it("uses an IPv4 HTTPS agent for direct downloads when forceIpv4 is enabled", async () => {
    configMock.telegram.forceIpv4 = true;
    const fetchMock = makeFetchStub();
    vi.stubGlobal("fetch", fetchMock);

    const { downloadTelegramFile } = await loadDownloadModule();
    await downloadTelegramFile(makeApiStub(), "fid");

    const call = defined(fetchMock.mock.calls[0]);
    const [, init] = call;
    const agent = (init as { agent?: unknown } | undefined)?.agent;
    expect(agent).toBeInstanceOf(HttpsAgent);
    expect((agent as HttpsAgent).options.family).toBe(4);
  });
});
