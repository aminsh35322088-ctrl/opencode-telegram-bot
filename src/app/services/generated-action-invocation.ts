/** Pure validation shared by persistence and public Global snapshot projection. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type GeneratedActionInvocation =
  | { kind: "mcp-tool"; tool: string; server?: string }
  | { kind: "native-tool"; tool: string; arguments?: Record<string, string> }
  | {
      kind: "action-tool";
      tool: string;
      actionArgument: string;
      actionValue: string;
      arguments?: Record<string, string>;
    };

export function validateGeneratedActionInvocation(value: unknown): GeneratedActionInvocation {
  if (
    !isRecord(value) ||
    !["native-tool", "action-tool", "mcp-tool"].includes(String(value.kind)) ||
    typeof value.tool !== "string" ||
    !value.tool.trim() ||
    value.tool.length > 128
  )
    throw new Error("Invalid generated action invocation.");
  const kind = value.kind as GeneratedActionInvocation["kind"];
  const allowed = new Set([
    "kind",
    "tool",
    ...(kind === "mcp-tool" ? ["server"] : ["arguments"]),
    ...(kind === "action-tool" ? ["actionArgument", "actionValue"] : []),
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)))
    throw new Error("Invalid invocation field.");
  const result: Record<string, unknown> = { kind, tool: value.tool };
  if (kind === "mcp-tool" && value.server !== undefined) {
    if (typeof value.server !== "string" || !value.server.trim() || value.server.length > 128)
      throw new Error("Invalid MCP server.");
    result.server = value.server;
  }
  if (kind === "action-tool") {
    if (
      typeof value.actionArgument !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(value.actionArgument) ||
      typeof value.actionValue !== "string" ||
      !value.actionValue ||
      value.actionValue.length > 128
    )
      throw new Error("Invalid action invocation discriminator.");
    result.actionArgument = value.actionArgument;
    result.actionValue = value.actionValue;
  }
  if (value.arguments !== undefined) {
    if (!isRecord(value.arguments) || Object.keys(value.arguments).length > 16)
      throw new Error("Invalid fixed arguments.");
    const args: Record<string, string> = {};
    for (const [key, item] of Object.entries(value.arguments)) {
      if (
        !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(key) ||
        /secret|token|password|credential|authorization|api.?key/i.test(key) ||
        typeof item !== "string" ||
        item.length > 1024 ||
        /Bearer\s|-----BEGIN .*PRIVATE KEY/i.test(item)
      )
        throw new Error("Invalid fixed argument.");
      args[key] = item;
    }
    if (kind === "action-tool" && Object.hasOwn(args, String(value.actionArgument)))
      throw new Error("Fixed argument conflicts with action discriminator.");
    result.arguments = args;
  }
  return result as unknown as GeneratedActionInvocation;
}

