import { describe, expect, it } from "vitest";
import { extractJsonRpcMessages } from "../../../src/app/services/mcp-client-service.js";

describe("MCP stdio JSON-RPC framing", () => {
  it("returns complete messages and keeps a trailing partial line buffered", () => {
    const { messages, rest } = extractJsonRpcMessages(
      '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n{"jsonrpc":"2.0","id":2,"resu',
    );
    expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
    expect(rest).toBe('{"jsonrpc":"2.0","id":2,"resu');
  });

  it("skips blank lines and unparsable server noise", () => {
    const { messages, rest } = extractJsonRpcMessages(
      '\nstarting up\n{"jsonrpc":"2.0","id":7,"result":[1,2]}\n\n{"jsonrpc":"2.0","method":"notifications/message"}\n',
    );
    expect(messages).toEqual([
      { jsonrpc: "2.0", id: 7, result: [1, 2] },
      { jsonrpc: "2.0", method: "notifications/message" },
    ]);
    expect(rest).toBe("");
  });

  it("ignores trailing data without a newline", () => {
    const { messages, rest } = extractJsonRpcMessages('{"jsonrpc":"2.0","id":1');
    expect(messages).toEqual([]);
    expect(rest).toBe('{"jsonrpc":"2.0","id":1');
  });
});
