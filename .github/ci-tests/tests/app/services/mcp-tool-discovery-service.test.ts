import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
});
