import type { DurableObjectNamespace, Queue, MessageBatch } from "@cloudflare/workers-types";
import { CONTROL_DEFAULTS } from "./control-config.js";
import { equalSecret } from "./control-secrets.js";
export interface ControlEnvironment {
  CONTROL: DurableObjectNamespace;
  JOBS: Queue<{ jobId: string }>;
  CONTROL_PLANE_URL: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_ALLOWED_USER_IDS?: string;
  TELEGRAM_ALLOWED_USER_ID?: string;
  RAILWAY_API_TOKEN: string;
  RAILWAY_WORKSPACE_ID: string;
  MAX_WORKERS: string;
  WORKERS_PER_PROJECT: string;
  MAX_RAILWAY_PROJECTS: string;
  PROVISION_ON_TOPIC_CREATE: string;
  ADMIN_TOKEN: string;
  CREDENTIAL_MASTER_KEY: string;
  PROVISIONING_ENABLED?: string;
  WORKER_IMAGE: string;
  WORKER_CORE_COMMIT: string;
  WORKER_CORE_VERSION: string;
}
export { ControlPlane } from "./control-object.js";
/** Public ingress authenticates before any privileged Durable Object operation. */
export default {
  async fetch(request: Request, env: ControlEnvironment): Promise<Response> {
    env = { ...CONTROL_DEFAULTS, ...env };
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health")
      return Response.json({
        ok: true,
        role: "control-plane",
        protocol: "revision-fenced-v1",
        execution: false,
        railwayCredentialPresent: Boolean(env.RAILWAY_API_TOKEN),
        telegramCredentialPresent: Boolean(env.TELEGRAM_BOT_TOKEN),
        provisioningEnabled: env.PROVISIONING_ENABLED === "true",
      });
    const path = url.pathname;
    if (request.method !== "POST" && !path.startsWith("/admin/"))
      return new Response("Not found", { status: 404 });
    if (path === "/telegram/webhook" || path.startsWith("/admin/")) {
      const kind = path === "/telegram/webhook" ? "webhook" : "admin";
      const supplied =
        request.headers.get(
          kind === "webhook" ? "X-Telegram-Bot-Api-Secret-Token" : "Authorization",
        ) ?? "";
      if (!supplied || supplied.length > 512) return new Response("Unauthorized", { status: 401 });
      const legacy = kind === "webhook" ? env.TELEGRAM_WEBHOOK_SECRET : env.ADMIN_TOKEN;
      let authorized = false;
      if (legacy)
        authorized = await equalSecret(supplied, kind === "admin" ? "Bearer " + legacy : legacy);
      else {
        try {
          const response = await env.CONTROL.getByName("canonical").fetch(
            "https://control.internal/control/auth",
            {
              method: "POST",
              body: JSON.stringify({ kind, supplied }),
            },
          );
          authorized =
            response.ok &&
            ((await response.json()) as { authorized?: boolean }).authorized === true;
        } catch {
          return Response.json({ error: "control_auth_unavailable" }, { status: 503 });
        }
      }
      if (!authorized) return new Response("Unauthorized", { status: 401 });
    } else if (!["/nodes/bootstrap", "/node-control", "/nodes/events"].includes(path))
      return new Response("Not found", { status: 404 });
    const length = Number(request.headers.get("Content-Length") ?? 0);
    if (length > 1024 * 1024) return new Response("Too large", { status: 413 });
    const reader = request.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader) {
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 1024 * 1024) {
            await reader.cancel();
            return new Response("Too large", { status: 413 });
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const body = new TextDecoder().decode(bytes);
    return env.CONTROL.getByName("canonical").fetch("https://control.internal" + path, {
      method: request.method,
      headers: {
        "Content-Type": "application/json",
        "x-node-signature": request.headers.get("x-node-signature") ?? "",
      },
      body: request.method === "GET" ? undefined : body,
    }) as unknown as Promise<Response>;
  },
  async queue(batch: MessageBatch<{ jobId: string }>, env: ControlEnvironment): Promise<void> {
    for (const message of batch.messages) {
      try {
        const response = await env.CONTROL.getByName("canonical").fetch(
          "https://control.internal/jobs/advance",
          { method: "POST", body: JSON.stringify(message.body) },
        );
        if (response.ok) message.ack();
        else message.retry({ delaySeconds: 30 });
      } catch {
        message.retry({ delaySeconds: 30 });
      }
    }
  },
};
