import dns from "node:dns/promises";
import net from "node:net";
import { tool } from "@opencode-ai/plugin";

export default tool({
  description: "Diagnose DNS, HTTP(S), and TCP connectivity from the Railway runtime without requiring raw shell networking tools.",
  args: {
    target: tool.schema.string().describe("Hostname, IP, URL, or host:port target."),
    mode: tool.schema.enum(["dns", "http", "tcp"]).describe("Diagnostic mode."),
    timeoutMs: tool.schema.number().optional().describe("Timeout in milliseconds, default 10000."),
  },
  async execute(args) {
    const timeout = Math.max(1000, Math.min(args.timeoutMs ?? 10000, 30000));
    if (args.mode === "dns") {
      const host = args.target.replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
      const [a, aaaa] = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host)]);
      return JSON.stringify({ host, ipv4: a.status === "fulfilled" ? a.value : [], ipv6: aaaa.status === "fulfilled" ? aaaa.value : [], ok: a.status === "fulfilled" || aaaa.status === "fulfilled" }, null, 2);
    }

    if (args.mode === "http") {
      const url = /^https?:\/\//i.test(args.target) ? args.target : `https://${args.target}`;
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(url, { method: "GET", redirect: "manual", signal: controller.signal });
        return JSON.stringify({ url, status: response.status, statusText: response.statusText, location: response.headers.get("location"), contentType: response.headers.get("content-type"), elapsedMs: Date.now() - started }, null, 2);
      } finally { clearTimeout(timer); }
    }

    const match = args.target.match(/^\[?([^\]]+)\]?:([0-9]+)$/);
    if (!match) throw new Error("TCP mode requires host:port (IPv6 may be written as [host]:port)");
    const host = match[1];
    const port = Number(match[2]);
    return await new Promise<string>((resolve) => {
      const started = Date.now();
      const socket = net.createConnection({ host, port });
      const timer = setTimeout(() => { socket.destroy(); resolve(JSON.stringify({ host, port, ok: false, error: "timeout", elapsedMs: Date.now() - started }, null, 2)); }, timeout);
      socket.once("connect", () => { clearTimeout(timer); socket.end(); resolve(JSON.stringify({ host, port, ok: true, elapsedMs: Date.now() - started }, null, 2)); });
      socket.once("error", (error) => { clearTimeout(timer); socket.destroy(); resolve(JSON.stringify({ host, port, ok: false, error: error.message, elapsedMs: Date.now() - started }, null, 2)); });
    });
  },
});
