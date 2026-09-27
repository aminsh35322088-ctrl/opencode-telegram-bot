import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PLAYWRIGHT_CLI = "playwright-cli";
const QWEN_URL = "https://chat.qwen.ai";
const MARKER = "__OTB_QWEN_BX__";
const COMMAND_TIMEOUT_MS = 70_000;
const CAPTURE_COOLDOWN_MS = 30 * 60_000;

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

function captureScript(): string {
  return `async page => {
    const marker = ${JSON.stringify(MARKER)};
    let captured = null;
    const onRequest = req => {
      if (!req.url().includes('/api/v2/')) return;
      const h = req.headers();
      const ua = h['bx-ua'];
      const umid = h['bx-umidtoken'];
      const v = h['bx-v'];
      if (!captured && ua && umid && v) captured = { bxUA: ua, bxUmidToken: umid, bxV: v };
    };
    page.on('request', onRequest);
    try {
      await page.goto(${JSON.stringify(QWEN_URL)}, { waitUntil: 'domcontentloaded', timeout: 60000 });
      for (let i = 0; i < 16 && !captured; i++) await page.waitForTimeout(500);

      const probe = await page.evaluate(async () => {
        const ts = Date.now();
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
              timestamp: ts,
              project_id: '',
            }),
          });
          const body = await res.text();
          return { status: res.status, body: body.slice(0, 400) };
        } catch (error) {
          return { status: 0, body: String(error).slice(0, 400) };
        }
      });

      for (let i = 0; i < 12 && !captured; i++) await page.waitForTimeout(500);
      if (!captured) {
        return marker + JSON.stringify({
          verified: false,
          status: probe.status,
          reason: 'Qwen page did not emit Baxia request headers',
        });
      }

      const body = String(probe.body || '').toLowerCase();
      const waf = body.includes('rgv587') || body.includes('x5secdata') ||
        body.includes('_____tmd_____') || body.includes('aliyun_waf');
      return marker + JSON.stringify({
        captured,
        verified: probe.status > 0 && !waf,
        status: probe.status,
        reason: waf ? 'Qwen still returned an Aliyun/Baxia challenge in-browser' : undefined,
      });
    } finally {
      page.off('request', onRequest);
    }
  }`;
}

function parseCaptureOutput(stdout: string): CapturePayload {
  const index = stdout.lastIndexOf(MARKER);
  if (index < 0) throw new Error("Playwright did not return a Qwen capture payload");
  const raw = stdout.slice(index + MARKER.length).trim();
  const line = raw.split(/\r?\n/, 1)[0] ?? "";
  const parsed = JSON.parse(line) as CapturePayload;
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
    const body = JSON.parse(await fs.readFile(statusPath, "utf8")) as { reason?: unknown };
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
  await fs.writeFile(scriptPath, captureScript(), { mode: 0o600 });

  try {
    await runCli(["--raw", `-s=${session}`, "open", "about:blank"], dataDir);
    const stdout = await runCli(["--raw", `-s=${session}`, "run-code", `--filename=${scriptPath}`], dataDir);
    const payload = parseCaptureOutput(stdout);
    const bxUA = payload.captured?.bxUA?.trim();
    const bxUmidToken = payload.captured?.bxUmidToken?.trim();
    const bxV = payload.captured?.bxV?.trim();

    if (!bxUA || !bxUmidToken || !bxV) {
      const reason = payload.reason || "Qwen browser bootstrap did not capture complete Baxia headers";
      await fs.writeFile(statusPath, JSON.stringify({ ok: false, reason, attemptedAt: Date.now() }) + "\n", { mode: 0o600 });
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
    await fs.writeFile(statusPath, JSON.stringify({ ok: false, reason, attemptedAt: Date.now() }) + "\n", { mode: 0o600 }).catch(() => {});
    return { ok: false, captured: false, verified: false, reason };
  } finally {
    await runCli(["--raw", `-s=${session}`, "close"], dataDir).catch(() => {});
    await fs.rm(scriptPath, { force: true }).catch(() => {});
  }
}

export const __test = {
  captureScript,
  parseCaptureOutput,
};
