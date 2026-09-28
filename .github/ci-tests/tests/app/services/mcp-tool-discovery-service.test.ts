import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverMcpToolIds } from "../../../src/app/services/mcp-tool-discovery-service.js";
import { saveManagedMcpServer } from "../../../src/app/services/mcp-server-store.js";

describe("MCP tool discovery fallback", () => {
  let home = "";

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-tool-discovery-"));
    process.env.OPENCODE_TELEGRAM_HOME = home;
  });

  afterEach(async () => {
    delete process.env.OPENCODE_TELEGRAM_HOME;
    await fs.rm(home, { recursive: true, force: true });
  });

  it("discovers real stdio MCP tools and applies the OpenCode server prefix", async () => {
    const serverFile = path.join(home, "mcp-test.mjs");
    await fs.writeFile(serverFile, [
      'let buffer = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => {',
      '  buffer += chunk;',
      '  let index;',
      '  while ((index = buffer.indexOf("\\n")) >= 0) {',
      '    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);',
      '    if (!line.trim()) continue;',
      '    const message = JSON.parse(line);',
      '    const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");',
      '    if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "test", version: "1.0.0" } } });',
      '    else if (message.method === "tools/list") send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "ping_test", description: "Ping", inputSchema: { type: "object", properties: {} } }] } });',
      '    else if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });',
      '  }',
      '});',
    ].join("\n"), "utf8");

    await saveManagedMcpServer({
      projectDirectory: home,
      name: "pingtest",
      config: {
        type: "local",
        command: [process.execPath, serverFile],
      },
    });

    await expect(discoverMcpToolIds(home, "pingtest")).resolves.toEqual([
      "pingtest_ping_test",
    ]);
  });

  it("falls back to legacy SSE for remote MCP tool discovery", async () => {
    let stream: ServerResponse | null = null;
    let baseUrl = "";
    const send = (message: unknown) => {
      stream?.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    };
    const server = createServer(async (request, response) => {
      if (request.method === "POST" && request.url === "/mcp") {
        response.writeHead(405).end();
        return;
      }
      if (request.method === "GET" && request.url === "/mcp") {
        stream = response;
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        response.write(`event: endpoint\ndata: ${baseUrl}/messages\n\n`);
        return;
      }
      if (request.method === "POST" && request.url === "/messages") {
        let body = "";
        for await (const chunk of request) body += chunk.toString();
        response.writeHead(202).end();
        const message = JSON.parse(body) as {
          id?: string | number;
          method?: string;
          params?: { protocolVersion?: string };
        };
        if (message.method === "initialize") {
          send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "legacy-sse-test", version: "1.0.0" },
            },
          });
        } else if (message.method === "tools/list") {
          send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              tools: [{
                name: "legacy_ping",
                description: "Legacy SSE ping",
                inputSchema: { type: "object", properties: {} },
              }],
            },
          });
        }
        return;
      }
      response.writeHead(404).end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      await saveManagedMcpServer({
        projectDirectory: home,
        name: "legacymcp",
        config: {
          type: "remote",
          url: `${baseUrl}/mcp`,
        },
      });
      await expect(discoverMcpToolIds(home, "legacymcp")).resolves.toEqual([
        "legacymcp_legacy_ping",
      ]);
    } finally {
      stream?.end();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
