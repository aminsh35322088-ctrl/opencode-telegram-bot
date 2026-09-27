import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PLAYWRIGHT_CLI = "playwright-cli";
const QWEN_URL = "https://chat.qwen.ai";
const QWEN_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const MARKER = "__OTB_QWEN_BX__";
const COMMAND_TIMEOUT_MS = 70_000;
const CAPTURE_COOLDOWN_MS = 30 * 60_000;
const BOOTSTRAP_STATUS_VERSION = 2;

export interface QwenGuestBootstrapResult {
  ok: boolean;
  captured: boolean;
  verified: boolean;
  skipped?: boolean;
  reason?: string;
  filePath?: string;
}

interface CapturePayload {
  captured?: {
    bxUA?: string;
    bxUmidToken?: string;
    bxV?: string;
  };
  verified?: boolean;
  status?: number;
  reason?: string;
}

function sanitizedBrowserEnv(dataDir: string): NodeJS.ProcessEnv {
  const home = path.join(dataDir, "browser-home");
  return {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/ms-playwright",
    PLAYWRIGHT_MCP_TIMEOUT_NAVIGATION: "60000",
    LANG: process.env.LANG || "C.UTF-8",
    TZ: process.env.TZ || "UTC",
  };
}

export function captureScript(): string {
  return `async page => {
    const marker = ${JSON.stringify(MARKER)};
    let captured = null;
    let completionHeaders = null;
    const onRequest = req => {
      if (!req.url().includes('/api/v2/')) return;
      const h = req.headers();
      const ua = h['bx-ua'];
      const umid = h['bx-umidtoken'];
      const v = h['bx-v'];
      if (ua && umid && v) {
        const headers = { bxUA: ua, bxUmidToken: umid, bxV: v };
        if (!captured) captured = headers;
        if (req.url().includes('/api/v2/chat/completions')) completionHeaders = headers;
      }
    };
    const waf = text => {
      const low = String(text || '').toLowerCase();
      return low.includes('rgv587') || low.includes('x5secdata') ||
        low.includes('_____tmd_____') || low.includes('aliyun_waf');
    };

    page.on('request', onRequest);
    try {
      await page.goto(${JSON.stringify(QWEN_URL)}, { waitUntil: 'domcontentloaded', timeout: 60000 });

      // Match upstream qwen-bx ordering: first let the real Qwen page make its
      // own API calls so Baxia has time to initialize and inject bx-* headers.
      for (let i = 0; i < 24 && !captured; i++) await page.waitForTimeout(500);

      // If the page stayed quiet, poke chats/new only after Baxia had a chance
      // to initialize, then wait again for the browser-injected header trio.
      if (!captured) {
        await page.evaluate(async () => {
          try {
            const res = await fetch('/api/v2/chats/new', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                source: 'web',
                version: '0.2.91',
                'x-request-id': crypto.randomUUID(),
              },
              body: JSON.stringify({
                title: 'New Chat',
                models: ['qwen3.8-max'],
                chat_mode: 'guest',
                chat_type: 't2t',
                timestamp: Date.now(),
                project_id: '',
              }),
            });
            await res.text();
          } catch {}
        });
        for (let i = 0; i < 16 && !captured; i++) await page.waitForTimeout(500);
      }

      if (!captured) {
        return marker + JSON.stringify({
          verified: false,
          status: 0,
          reason: 'Qwen page did not emit Baxia request headers after upstream-style warm-up',
        });
      }

      // Now mirror upstream qwen-bx verification: create a guest chat and
      // require the completions request to get past Aliyun WAF.
      const probe = await page.evaluate(async () => {
        const ts = Date.now();
        try {
          const newRes = await fetch('/api/v2/chats/new', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              source: 'web',
              version: '0.2.91',
              'x-request-id': crypto.randomUUID(),
            },
            body: JSON.stringify({
              title: 'New Chat',
              models: ['qwen3.8-max'],
              chat_mode: 'guest',
              chat_type: 't2t',
              timestamp: ts,
              project_id: '',
            }),
          });
          const newText = await newRes.text();
          let chatId = null;
          try { chatId = JSON.parse(newText)?.data?.id || null; } catch {}
          if (!chatId) return { step: 'chats/new', status: newRes.status, ct: '', body: newText.slice(0, 700) };

          const body = {
            stream: true,
            incremental_output: true,
            chat_id: chatId,
            chat_mode: 'guest',
            model: 'qwen3.8-max',
            parent_id: null,
            messages: [{
              fid: crypto.randomUUID().replace(/-/g, ''),
              parentId: null,
              childrenIds: [crypto.randomUUID().replace(/-/g, '')],
              role: 'user',
              content: 'Say hi in one short sentence.',
              user_action: 'chat',
              files: [],
              timestamp: ts,
              models: ['qwen3.8-max'],
              chat_type: 't2t',
              feature_config: {
                thinking_enabled: true,
                output_schema: 'phase',
                thinking_mode: 'Auto',
                thinking_format: 'summary',
              },
              extra: { meta: { subChatType: 't2t' } },
              sub_chat_type: 't2t',
              parent_id: null,
            }],
            timestamp: ts,
          };
          const res = await fetch('/api/v2/chat/completions?chat_id=' + encodeURIComponent(chatId), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream',
              source: 'web',
              version: '0.2.91',
              'x-request-id': crypto.randomUUID(),
              'x-accel-buffering': 'no',
            },
            body: JSON.stringify(body),
          });
          const txt = await res.text();
          return {
            step: 'completions',
            status: res.status,
            ct: res.headers.get('content-type') || '',
            body: txt.slice(0, 700),
          };
        } catch (error) {
          return { step: 'exception', status: 0, ct: '', body: String(error).slice(0, 700) };
        }
      });

      const blocked = waf(probe.body);
      const verified = probe.step === 'completions' &&
        !blocked &&
        (String(probe.ct).toLowerCase().startsWith('text/event-stream') || probe.status > 0);

      return marker + JSON.stringify({
        captured: completionHeaders || captured,
        verified,
        status: probe.status,
        reason: verified
          ? undefined
          : 'Qwen full in-browser guest completion did not pass Baxia verification',
      });
    } finally {
      page.off('request', onRequest);
    }
  }`;
}

function parseCaptureOutput(stdout: string): CapturePayload {
  const trimmed = stdout.trim();
  let decoded = trimmed;

  // playwright-cli run-code JSON.stringify()s the function return value before
  // exposing it as the tool result. Because our function intentionally returns
  // a marker-prefixed JSON string, --raw therefore prints a JSON-encoded
  // string (quotes + escaped inner JSON). Decode that outer layer first.
  try {
    const outer = JSON.parse(trimmed) as unknown;
    if (typeof outer === "string") decoded = outer;
  } catch {
    // Older/alternate CLI output can already be the raw marker string.
  }

  const index = decoded.lastIndexOf(MARKER);
  if (index < 0) throw new Error("Playwright did not return a Qwen capture payload");
  const raw = decoded.slice(index + MARKER.length).trim();
  const parsed = JSON.parse(raw) as CapturePayload;
  return parsed && typeof parsed === "object" ? parsed : {};
}

async function runCli(args: string[], dataDir: string): Promise<string> {
  const { stdout } = await execFileAsync(PLAYWRIGHT_CLI, args, {
    env: sanitizedBrowserEnv(dataDir),
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout;
}

async function readRecentFailure(statusPath: string): Promise<string | null> {
  try {
    const stat = await fs.stat(statusPath);
    if (Date.now() - stat.mtimeMs >= CAPTURE_COOLDOWN_MS) return null;
    const body = JSON.parse(await fs.readFile(statusPath, "utf8")) as { version?: unknown; reason?: unknown };
    if (body.version !== BOOTSTRAP_STATUS_VERSION) return null;
    return typeof body.reason === "string" ? body.reason : "recent automatic Qwen repair failed";
  } catch {
    return null;
  }
}

export async function bootstrapQwenGuestHeaders(
  dataDir: string,
  options: { force?: boolean } = {},
): Promise<QwenGuestBootstrapResult> {
  const bxPath = path.join(dataDir, "qwen-bx.json");
  const statusPath = path.join(dataDir, "qwen-bootstrap-status.json");
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });

  if (!options.force) {
    const recentFailure = await readRecentFailure(statusPath);
    if (recentFailure) {
      return { ok: false, captured: false, verified: false, skipped: true, reason: recentFailure };
    }
  }

  const session = "otb-qwen-" + randomBytes(6).toString("hex");
  const scriptPath = path.join(dataDir, `.qwen-bootstrap-${session}.js`);
  const configPath = path.join(dataDir, `.qwen-bootstrap-${session}.json`);
  await fs.mkdir(path.join(dataDir, "browser-home"), { recursive: true, mode: 0o700 });
  await fs.writeFile(scriptPath, captureScript(), { mode: 0o600 });
  await fs.writeFile(configPath, JSON.stringify({
    browser: {
      browserName: "chromium",
      launchOptions: {
        args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
      },
      contextOptions: {
        userAgent: QWEN_USER_AGENT,
        locale: "en-US",
        viewport: { width: 1280, height: 850 },
      },
    },
  }, null, 2) + "\n", { mode: 0o600 });

  try {
    await runCli(["--raw", `--config=${configPath}`, `-s=${session}`, "open", "about:blank"], dataDir);
    const stdout = await runCli(["--raw", `-s=${session}`, "run-code", `--filename=${scriptPath}`], dataDir);
    const payload = parseCaptureOutput(stdout);
    const bxUA = payload.captured?.bxUA?.trim();
    const bxUmidToken = payload.captured?.bxUmidToken?.trim();
    const bxV = payload.captured?.bxV?.trim();

    if (!bxUA || !bxUmidToken || !bxV) {
      const reason = payload.reason || "Qwen browser bootstrap did not capture complete Baxia headers";
      await fs.writeFile(statusPath, JSON.stringify({ version: BOOTSTRAP_STATUS_VERSION, ok: false, reason, attemptedAt: Date.now() }) + "\n", { mode: 0o600 });
      return { ok: false, captured: false, verified: false, reason };
    }

    await fs.writeFile(bxPath, JSON.stringify({
      "bx-ua": bxUA,
      "bx-umidtoken": bxUmidToken,
      "bx-v": bxV,
      captured_unix: Math.floor(Date.now() / 1000),
      verified: Boolean(payload.verified),
    }, null, 2) + "\n", { mode: 0o600 });
    await fs.rm(statusPath, { force: true }).catch(() => {});

    return {
      ok: true,
      captured: true,
      verified: Boolean(payload.verified),
      reason: payload.reason,
      filePath: bxPath,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await fs.writeFile(statusPath, JSON.stringify({ version: BOOTSTRAP_STATUS_VERSION, ok: false, reason, attemptedAt: Date.now() }) + "\n", { mode: 0o600 }).catch(() => {});
    return { ok: false, captured: false, verified: false, reason };
  } finally {
    await runCli(["--raw", `-s=${session}`, "close"], dataDir).catch(() => {});
    await fs.rm(scriptPath, { force: true }).catch(() => {});
    await fs.rm(configPath, { force: true }).catch(() => {});
  }
}

export const __test = {
  captureScript,
  parseCaptureOutput,
};
