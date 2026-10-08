import type { FleetTopic } from "./control-store.js";
import type { LegacyUiAdapter } from "./legacy-ui-adapter.js";

export interface LegacyDownload {
  path: string;
  filename: string;
  content: string | Uint8Array;
  encoding: "utf8" | "base64";
}

export function normalizeWorkspacePath(input: string | undefined): string {
  const value = (input ?? ".").trim();
  if (!value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value))
    throw new Error("invalid_workspace_path");

  const parts: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!parts.length) throw new Error("invalid_workspace_path");
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/") || ".";
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export class LegacySessionAdapter {
  constructor(private readonly ui: LegacyUiAdapter) {}

  session<T = unknown>(topic: FleetTopic): Promise<T> {
    return this.ui.rpc<T>(topic, "session.get");
  }

  messages<T = unknown[]>(topic: FleetTopic): Promise<T> {
    return this.ui.rpc<T>(topic, "session.messages");
  }

  context<T = unknown[]>(topic: FleetTopic): Promise<T> {
    return this.ui.rpc<T>(topic, "session.messages");
  }

  async userMessages(topic: FleetTopic): Promise<Array<{ id: string; text: string; created: number }>> {
    const raw = await this.messages<unknown[]>(topic);
    return (Array.isArray(raw) ? raw : [])
      .map((value) => {
        const message = record(value);
        const info = record(message.info);
        if (info.role !== "user") return undefined;
        const parts = Array.isArray(message.parts) ? message.parts : [];
        const text = parts
          .filter((part) => record(part).type === "text" && typeof record(part).text === "string")
          .map((part) => String(record(part).text))
          .join("")
          .trim();
        if (!text) return undefined;
        return {
          id: String(info.id ?? record(info.time).created ?? ""),
          text,
          created: Number(record(info.time).created ?? 0),
        };
      })
      .filter((value): value is { id: string; text: string; created: number } => Boolean(value))
      .sort((a, b) => b.created - a.created);
  }

  todos<T = unknown[]>(topic: FleetTopic): Promise<T> {
    return this.ui.rpc<T>(topic, "session.todos");
  }

  diff<T = unknown>(topic: FleetTopic): Promise<T> {
    return this.ui.rpc<T>(topic, "session.diff");
  }

  children<T = unknown[]>(topic: FleetTopic): Promise<T> {
    return this.ui.rpc<T>(topic, "session.children");
  }

  childMessages<T = unknown[]>(topic: FleetTopic, childId: string): Promise<T> {
    const id = childId.trim();
    if (!id || id.length > 256 || id.includes("\0")) return Promise.reject(new Error("invalid_child_session"));
    return this.ui.rpc<T>(topic, "session.child-messages", { childId: id });
  }

  list<T = unknown>(topic: FleetTopic, path = "."): Promise<T> {
    return this.ui.rpc<T>(topic, "file.list", { path: normalizeWorkspacePath(path) });
  }

  read<T = unknown>(topic: FleetTopic, path: string): Promise<T> {
    const normalized = normalizeWorkspacePath(path);
    if (normalized === ".") return Promise.reject(new Error("invalid_workspace_path"));
    return this.ui.rpc<T>(topic, "file.read", { path: normalized });
  }

  async download(topic: FleetTopic, path: string): Promise<LegacyDownload> {
    const normalized = normalizeWorkspacePath(path);
    if (normalized === ".") throw new Error("invalid_workspace_path");
    const file = record(await this.read(topic, normalized));
    const encoding = file.encoding === "base64" ? "base64" : "utf8";
    const raw = String(file.content ?? "");
    const content =
      encoding === "base64"
        ? Uint8Array.from(atob(raw), (character) => character.charCodeAt(0))
        : raw;
    return {
      path: normalized,
      filename:
        normalized
          .split("/")
          .at(-1)!
          .replace(/[^A-Za-z0-9_.-]/g, "_")
          .slice(0, 128) || "file",
      content,
      encoding,
    };
  }
}
