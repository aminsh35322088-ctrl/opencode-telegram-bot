import type { ControlStore, SqlDatabase } from "./control-store.js";
import type { CloudTelegram } from "./telegram.js";
import { validateGeneratedActionInvocation } from "../app/services/generated-action-invocation.js";
import { t } from "../i18n/index.js";
import { buildSkillMarkdown, normalizeFrontmatterValue } from "../app/services/skill-markdown.js";

export interface ConfigButton {
  text: string;
  callback_data: string;
}
/** Parent binds these operations to an authorized actor/chat/thread/generation. */
export interface ConfigContext {
  store: ControlStore;
  sql: SqlDatabase;
  telegram: CloudTelegram;
  draftKey?: string;
  markCommitted?(): void;
  commit(data: Record<string, unknown>, expectedRevision: number): Promise<void>;
  button(label: string, action: string, value?: string): ConfigButton;
  prompt(kind: string, text: string): Promise<void>;
  notice(text: string): Promise<void>;
  menu(text: string, rows: ConfigButton[][]): Promise<void>;
}
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(obj) : []);
const esc = (v: unknown) =>
  String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
const id = (v: unknown): string => {
  if (
    typeof v !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(v) ||
    ["__proto__", "constructor", "prototype"].includes(v)
  )
    throw new Error("invalid_configuration_id");
  return v;
};
const extensionIdentity = (v: unknown): string => {
  if (
    typeof v !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,511}$/.test(v) ||
    v.split(/[/:]/).some((part) => ["__proto__", "constructor", "prototype"].includes(part))
  )
    throw new Error("invalid_extension_id");
  return v;
};
const actionRisk = (identity: string, action: string, tool: string): string => {
  const parts = new Set(
    (identity + " " + action + " " + tool)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  const has = (...values: string[]) => values.some((value) => parts.has(value));
  if (has("delete", "destroy", "remove", "purge", "drop", "terminate")) return "destructive";
  if (
    has(
      "exec",
      "shell",
      "command",
      "deploy",
      "restart",
      "redeploy",
      "create",
      "update",
      "set",
      "write",
      "upload",
      "trigger",
      "cancel",
    )
  )
    return "mutating";
  if (has("download", "export", "save")) return "write";
  if (
    has(
      "list",
      "get",
      "read",
      "status",
      "inspect",
      "describe",
      "resolve",
      "query",
      "search",
      "view",
      "show",
    )
  )
    return "read";
  return "external";
};
const text = (v: unknown, maximum = 20000): string => {
  if (typeof v !== "string" || !v.trim() || v.length > maximum || v.includes("\0"))
    throw new Error("invalid_configuration_text");
  return v.trim();
};
const url = (v: unknown): string => {
  const u = new URL(text(v, 2048));
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password || u.search || u.hash)
    throw new Error("invalid_public_endpoint");
  return u.href;
};
function noSecrets(v: unknown): void {
  if (Array.isArray(v)) {
    for (const child of v) noSecrets(child);
    return;
  }
  for (const [key, child] of Object.entries(obj(v))) {
    if (/api.?key|token|password|secret|authorization|credential(?!Ref$)/i.test(key))
      throw new Error("use_protected_credential_reference");
    noSecrets(child);
  }
}
const plugin = (v: unknown): string => {
  const s = text(v, 512);
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+@[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/i.test(s))
    throw new Error("immutable_plugin_version_required");
  return s;
};
async function hash(content: string): Promise<string> {
  return [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content))),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
const sections = [
  "providers",
  "extensions",
  "actions",
  "skills",
  "mcps",
  "plugins",
  "commands",
] as const;
type Section = (typeof sections)[number];
interface ConfigDraft {
  id: string;
  section: "skills" | "commands" | "mcps";
  stage: "name" | "description" | "content" | "confirm" | "saved";
  expires: number;
  name?: string;
  description?: string;
  candidate?: Record<string, unknown>;
  revision?: number;
}
const labels: Record<Section, string> = {
  providers: "🔌 Providers",
  extensions: "🧩 Extensions",
  actions: "⚡ Actions",
  skills: "🧠 Skills",
  mcps: "🔗 MCP",
  plugins: "🧩 Plugins",
  commands: "🧩 Custom Commands",
};
export const OUTPUT_DEFAULTS = {
  compactOutputMode: false,
  showThinkingContent: true,
  showAssistantRunFooter: true,
  sendDiffFileAttachments: true,
  promptQueueEnabled: true,
  responseStreamingMode: "edit",
  messageFormatMode: "markdown",
} satisfies Record<string, boolean | string>;
type OutputField = keyof typeof OUTPUT_DEFAULTS;
const outputLabels: Record<OutputField, string> = {
  compactOutputMode: "📦 Compact output",
  showThinkingContent: "💭 Thinking",
  showAssistantRunFooter: "📊 Run footer",
  sendDiffFileAttachments: "📎 File changes",
  promptQueueEnabled: "📥 Prompt queue",
  responseStreamingMode: "💬 Streaming",
  messageFormatMode: "📝 Message format",
};
export function outputSettingLabel(field: OutputField, value: unknown): string {
  const display =
    field === "responseStreamingMode"
      ? value === "off"
        ? "OFF"
        : "ON"
      : field === "messageFormatMode"
        ? value === "raw"
          ? "Raw text"
          : "Formatted"
        : value
          ? "ON"
          : "OFF";
  return outputLabels[field] + " · " + display;
}

export class CloudConfigUi {
  constructor(private readonly ctx: ConfigContext) {}
  private writeDraft(draft: ConfigDraft): void {
    if (!this.ctx.draftKey) throw new Error("configuration_scope_missing");
    this.ctx.sql.exec(
      "INSERT INTO ui_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
      this.ctx.draftKey,
      JSON.stringify(draft),
    );
  }
  private draft(): ConfigDraft {
    if (!this.ctx.draftKey) throw new Error("configuration_scope_missing");
    const row = [
      ...this.ctx.sql.exec<{ data: string }>(
        "SELECT data FROM ui_state WHERE key=?",
        this.ctx.draftKey,
      ),
    ][0];
    if (!row) throw new Error("configuration_draft_expired");
    const draft = JSON.parse(row.data) as ConfigDraft;
    if (draft.expires <= Date.now()) throw new Error("configuration_draft_expired");
    return draft;
  }
  private contentPrompt(section: ConfigDraft["section"]): string {
    return t(
      section === "skills"
        ? "skills.wizard.ask_body"
        : section === "mcps"
          ? "mcps.add.remote_prompt"
          : "config.wizard.command",
      undefined,
      "en",
    );
  }
  private snapshot() {
    const s = this.ctx.store.global();
    if (!s) throw new Error("snapshot_unavailable");
    return s;
  }
  private entries(section: Section, data: Record<string, unknown>): Record<string, unknown>[] {
    const c = obj(data.configuration),
      runtime = obj(c.runtime);
    if (section === "providers")
      return Object.entries(obj(runtime.provider)).map(([id, v]) => ({
        ...obj(v),
        id,
        enabled: !(
          Array.isArray(runtime.disabled_providers) && runtime.disabled_providers.includes(id)
        ),
      }));
    if (section === "mcps")
      return Object.entries(obj(runtime.mcp)).map(([id, v]) => ({ ...obj(v), id }));
    if (section === "commands")
      return [
        ...Object.entries(obj(runtime.command)).map(([id, v]) => ({
          ...obj(v),
          id,
          enabled: true,
        })),
        ...list(c.disabledCommands).map((v) => ({ ...v, enabled: false })),
      ];
    if (section === "skills")
      return [
        ...list(data.skills).map((v) => ({ ...v, id: v.name, enabled: true })),
        ...list(c.disabledSkills).map((v) => ({ ...v, id: v.name, enabled: false })),
      ];
    if (section === "plugins")
      return [
        ...(Array.isArray(runtime.plugin) ? runtime.plugin : []).map((v) => ({
          id: String(v),
          enabled: true,
        })),
        ...(Array.isArray(c.disabledPlugins) ? c.disabledPlugins : []).map((v) => ({
          id: String(v),
          enabled: false,
        })),
      ];
    return list(section === "actions" ? data.actions : c.extensions);
  }
  private async mutate(
    change: (data: Record<string, unknown>) => void | Promise<void>,
    committed?: () => void,
  ): Promise<void> {
    const s = this.snapshot(),
      data = structuredClone(s.data);
    await change(data);
    await this.ctx.commit(data, s.revision);
    committed?.();
    await this.ctx.notice("✅ Configuration saved.");
  }
  private async render(section: Section): Promise<void> {
    const entries = this.entries(section, this.snapshot().data),
      b = this.ctx.button.bind(this.ctx);
    const rows: ConfigButton[][] = [];
    for (const e of entries.slice(0, 40)) {
      const key = String(e.id);
      rows.push([
        b(
          (e.enabled === false ? "○ " : "● ") + String(e.name ?? key),
          "config_item_" + section,
          key,
        ),
      ]);
    }
    rows.push([
      b(
        section === "mcps" && this.ctx.draftKey ? "＋ Remote MCP" : "＋ Add / Edit",
        "config_add_" + section,
      ),
    ]);
    if (this.ctx.draftKey && ["skills", "commands", "mcps"].includes(section))
      rows.push([b("Advanced JSON", "config_json_" + section)]);
    rows.push([b("← Settings", "settings")]);
    await this.ctx.menu(
      "<b>" +
        labels[section] +
        "</b>\n\nGlobal configuration is shared by all Topics." +
        (entries.length ? "" : "\nNo entries configured."),
      rows,
    );
  }
  private setEntries(
    section: Section,
    data: Record<string, unknown>,
    entries: Record<string, unknown>[],
  ): void {
    const c = obj(data.configuration),
      runtime = obj(c.runtime);
    data.configuration = c;
    c.runtime = runtime;
    if (section === "providers" || section === "mcps") {
      runtime[section === "providers" ? "provider" : "mcp"] = Object.fromEntries(
        entries.map((e) => {
          const { id, ...v } = e;
          if (section === "providers") delete v.enabled;
          return [String(id), v];
        }),
      );
      return;
    }
    if (section === "commands") {
      runtime.command = Object.fromEntries(
        entries
          .filter((e) => e.enabled !== false)
          .map((e) => {
            const { id, enabled, ...command } = e;
            void enabled;
            return [String(id), command];
          }),
      );
      c.disabledCommands = entries.filter((e) => e.enabled === false);
      return;
    }
    if (section === "skills") {
      const clean = (e: Record<string, unknown>) => ({
        name: e.name,
        content: e.content,
        hash: e.hash,
      });
      data.skills = entries.filter((e) => e.enabled !== false).map(clean);
      c.disabledSkills = entries.filter((e) => e.enabled === false).map(clean);
      return;
    }
    if (section === "plugins") {
      runtime.plugin = entries.filter((e) => e.enabled !== false).map((e) => e.id);
      c.disabledPlugins = entries.filter((e) => e.enabled === false).map((e) => e.id);
      return;
    }
    if (section === "actions") data.actions = entries;
    else c.extensions = entries;
  }
  private async candidate(
    section: Section,
    input: string,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    let v: Record<string, unknown>;
    try {
      v = obj(JSON.parse(input));
    } catch {
      throw new Error("invalid_configuration_json");
    }
    noSecrets(v);
    if (section === "skills") {
      const name = id(v.name);
      text(v.content, 131072);
      const content = v.content as string;
      return { id: name, name, content, hash: await hash(content), enabled: true };
    }
    if (section === "plugins") return { id: plugin(v.specifier), enabled: v.enabled !== false };
    const key = section === "extensions" ? extensionIdentity(v.id) : id(v.id);
    if (section === "commands") {
      const allowed = new Set([
        "id",
        "template",
        "description",
        "agent",
        "model",
        "variant",
        "subtask",
      ]);
      if (Object.keys(v).some((key) => !allowed.has(key))) throw new Error("invalid_command_field");
      const template = text(v.template, 20000);
      if (
        /Bearer\s|-----BEGIN .*PRIVATE KEY|(?:api[-_]?key|token|password|secret)\s*[=:]\s*\S+/i.test(
          template,
        )
      )
        throw new Error("use_protected_credential_reference");
      const command: Record<string, unknown> = { id: key, template, enabled: true };
      if (v.description !== undefined) command.description = text(v.description, 2000);
      if (v.agent !== undefined) command.agent = id(v.agent);
      if (v.variant !== undefined) command.variant = id(v.variant);
      if (v.model !== undefined) {
        const model = text(v.model, 256);
        if (!/^[^/\s]{1,128}\/[^\s]{1,128}$/.test(model)) throw new Error("invalid_command_model");
        command.model = model;
      }
      if (v.subtask !== undefined) {
        if (typeof v.subtask !== "boolean") throw new Error("invalid_command_subtask");
        command.subtask = v.subtask;
      }
      return command;
    }
    if (section === "mcps") {
      if (v.type === "remote")
        return {
          id: key,
          type: "remote",
          url: url(v.url),
          enabled: v.enabled !== false,
          ...(v.timeout === undefined ? {} : { timeout: this.timeout(v.timeout) }),
        };
      if (
        v.type === "local" &&
        Array.isArray(v.command) &&
        v.command.length > 0 &&
        v.command.length <= 32 &&
        v.command.every(
          (a) =>
            typeof a === "string" &&
            a.length <= 2048 &&
            !/[\x00-\x1f]|api.?key|token|password|secret|authorization|credential|--env|--header|^-H$|^-u$|^-c$|^-e$|[A-Z_][A-Z0-9_]*=/i.test(
              a,
            ),
        )
      )
        return { id: key, type: "local", command: v.command, enabled: v.enabled !== false };
      throw new Error("invalid_mcp_configuration");
    }
    if (section === "providers") {
      const options: Record<string, unknown> = { baseURL: url(v.baseURL) };
      if (v.credentialRef !== undefined) {
        const ref = text(v.credentialRef, 256);
        const reference = list(data.credentialReferences).find(
          (r) => r.id === ref && r.configured === true,
        );
        if (!reference) throw new Error("protected_credential_reference_missing");
        const capability = reference.capability ?? reference.extensionId;
        if (capability !== "model-provider:" + key || typeof reference.credentialId !== "string")
          throw new Error("protected_credential_capability_mismatch");
        options.apiKey = "bot-credential-proxy:" + capability + ":" + id(reference.credentialId);
      }
      const models = obj(v.models);
      if (!Object.keys(models).length || Object.keys(models).length > 256)
        throw new Error("provider_models_required");
      for (const [model, m] of Object.entries(models)) {
        text(model, 128);
        if (!Object.keys(obj(m)).length) throw new Error("invalid_provider_model");
      }
      return {
        id: key,
        npm: "@ai-sdk/openai-compatible",
        name: text(v.name ?? key, 128),
        options,
        models,
      };
    }
    if (section === "actions") {
      const extensionId = extensionIdentity(v.extensionId);
      const owner = list(obj(data.configuration).extensions).find((e) => e.id === extensionId);
      if (!owner) throw new Error("action_extension_missing");
      if (!/^[a-z0-9][a-z0-9._-]{1,127}$/.test(key)) throw new Error("invalid_action_id");
      const namespace =
        text(owner.name, 128)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ".")
          .replace(/^\.+|\.+$/g, "") || "extension";
      if (!key.startsWith(namespace + ".")) throw new Error("action_namespace_mismatch");
      const invocation = validateGeneratedActionInvocation(v.invocation);
      if (
        invocation.kind === "mcp-tool" &&
        (obj(owner.resource).kind !== "mcp" || invocation.server !== obj(owner.resource).serverName)
      )
        throw new Error("action_owner_mismatch");
      if (!["read", "write", "external", "mutating", "destructive"].includes(String(v.risk)))
        throw new Error("invalid_action_risk");
      const now = new Date().toISOString(),
        enabled = v.enabled !== false;
      return {
        id: key,
        extensionId,
        tool: text(v.tool, 128),
        action: text(v.action, 128),
        category: text(v.category, 80),
        risk: v.risk,
        description: text(v.description, 500),
        invocation,
        enabled,
        userDisabled: !enabled,
        createdAt: now,
        updatedAt: now,
      };
    }
    const resource = obj(v.resource);
    if (
      !["skill", "mcp", "plugin", "model-provider", "integration"].includes(String(resource.kind))
    )
      throw new Error("invalid_extension_resource");
    if (resource.kind === "plugin") plugin(resource.specifier);
    if (resource.kind === "skill") id(resource.skillName);
    if (resource.kind === "mcp") id(resource.serverName);
    if (resource.kind === "model-provider") id(resource.providerId);
    if (resource.kind === "integration") id(resource.adapter);
    return {
      id: key,
      name: text(v.name, 128),
      kind: resource.kind,
      source: text(v.source ?? "manual", 512),
      authType: "none",
      credentialSchemas: [],
      resource,
      managed: true,
      enabled: v.enabled !== false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }
  private timeout(v: unknown): number {
    if (!Number.isSafeInteger(v) || Number(v) < 1 || Number(v) > 300000)
      throw new Error("invalid_timeout");
    return Number(v);
  }
  async handle(action: string, value?: string): Promise<boolean> {
    if (action.startsWith("config_wizard_")) {
      const draft = this.draft();
      if (action === "config_wizard_name") {
        if (draft.stage !== "name") throw new Error("configuration_draft_stage_mismatch");
        let name: string;
        try {
          name = id(value?.trim());
          if (draft.section === "skills" && !/^[a-z0-9](?:-?[a-z0-9]){0,63}$/.test(name))
            throw new Error("invalid_skill_name");
        } catch {
          await this.ctx.prompt("config_wizard_name", t("config.wizard.name", undefined, "en"));
          return true;
        }
        this.writeDraft({
          ...draft,
          name,
          stage: draft.section === "skills" ? "description" : "content",
        });
        this.ctx.markCommitted?.();
        await this.ctx.prompt(
          draft.section === "skills" ? "config_wizard_description" : "config_wizard_content",
          draft.section === "skills"
            ? t("skills.wizard.ask_description", undefined, "en")
            : this.contentPrompt(draft.section),
        );
        return true;
      }
      if (action === "config_wizard_description") {
        if (draft.section !== "skills" || draft.stage !== "description")
          throw new Error("configuration_draft_stage_mismatch");
        let description: string;
        try {
          description = normalizeFrontmatterValue(text(value, 1024));
        } catch {
          await this.ctx.prompt(
            "config_wizard_description",
            t("skills.wizard.ask_description", undefined, "en"),
          );
          return true;
        }
        this.writeDraft({ ...draft, description, stage: "content" });
        this.ctx.markCommitted?.();
        await this.ctx.prompt("config_wizard_content", this.contentPrompt(draft.section));
        return true;
      }
      if (action === "config_wizard_content") {
        if (draft.stage !== "content") throw new Error("configuration_draft_stage_mismatch");
        let candidate: Record<string, unknown>;
        try {
          const input =
            draft.section === "skills"
              ? {
                  name: draft.name,
                  content: buildSkillMarkdown(draft.name!, draft.description!, text(value, 130000)),
                }
              : draft.section === "commands"
                ? { id: draft.name, template: value }
                : { id: draft.name, type: "remote", url: value };
          candidate = await this.candidate(
            draft.section,
            JSON.stringify(input),
            this.snapshot().data,
          );
        } catch {
          await this.ctx.prompt("config_wizard_content", this.contentPrompt(draft.section));
          return true;
        }
        this.writeDraft({
          ...draft,
          candidate,
          stage: "confirm",
          revision: this.snapshot().revision,
        });
        this.ctx.markCommitted?.();
        const preview = String(candidate.content ?? candidate.template ?? candidate.url);
        await this.ctx.menu(
          t(
            "config.wizard.confirm",
            {
              name: esc(draft.name),
              preview: esc(preview.slice(0, 500)) + (preview.length > 500 ? "…" : ""),
            },
            "en",
          ),
          [
            [
              this.ctx.button(
                t("config.wizard.save", undefined, "en"),
                "config_wizard_confirm",
                draft.id,
              ),
            ],
            [this.ctx.button(t("inline.button.cancel", undefined, "en"), "cancel")],
          ],
        );
        return true;
      }
      if (action !== "config_wizard_confirm") return false;
      if (value !== draft.id) throw new Error("configuration_draft_mismatch");
      if (draft.stage === "saved") return true;
      if (draft.stage !== "confirm" || !draft.candidate)
        throw new Error("configuration_draft_stage_mismatch");
      if (this.snapshot().revision !== draft.revision)
        throw new Error("configuration_revision_changed");
      await this.mutate(
        (data) => {
          const entries = this.entries(draft.section, data);
          this.setEntries(draft.section, data, [
            ...entries.filter((e) => e.id !== draft.candidate!.id),
            draft.candidate!,
          ]);
        },
        () => {
          this.writeDraft({ ...draft, stage: "saved" });
          this.ctx.markCommitted?.();
        },
      );
      return true;
    }
    if (sections.includes(action as Section)) {
      await this.render(action as Section);
      return true;
    }
    for (const section of sections) {
      if (action === "config_json_" + section) {
        if (this.ctx.draftKey)
          this.ctx.sql.exec("DELETE FROM ui_state WHERE key=?", this.ctx.draftKey);
        await this.ctx.prompt(
          "config_save_" + section,
          "Send " +
            section +
            " configuration as JSON, or /cancel. Never send credentials; use a configured protected credentialRef.",
        );
        return true;
      }
      if (action === "config_add_" + section) {
        if (this.ctx.draftKey && ["skills", "commands", "mcps"].includes(section)) {
          this.writeDraft({
            id: crypto.randomUUID(),
            section: section as ConfigDraft["section"],
            stage: "name",
            expires: Date.now() + 300000,
          });
          this.ctx.markCommitted?.();
          await this.ctx.prompt("config_wizard_name", t("config.wizard.name", undefined, "en"));
          return true;
        }
        await this.ctx.prompt(
          "config_save_" + section,
          "Send " +
            section +
            " configuration as JSON, or /cancel. Never send credentials; use a configured protected credentialRef.",
        );
        return true;
      }
      if (action === "config_item_" + section) {
        const e = this.entries(section, this.snapshot().data).find((e) => e.id === value);
        if (!e) throw new Error("configuration_entry_missing");
        const b = this.ctx.button.bind(this.ctx);
        await this.ctx.menu("<b>" + esc(e.name ?? e.id) + "</b>", [
          [b("Toggle Enabled", "config_toggle_" + section, value)],
          [
            b(
              "Edit",
              section === "mcps" && e.type === "local"
                ? "config_json_mcps"
                : "config_add_" + section,
            ),
          ],
          [b("Remove", "config_remove_" + section, value)],
          [b("← Back", section)],
        ]);
        return true;
      }
      if (action === "config_save_" + section) {
        await this.mutate(async (data) => {
          const e = await this.candidate(section, text(value, 150000), data),
            entries = this.entries(section, data),
            previous = entries.find((v) => v.id === e.id);
          if (previous?.createdAt) e.createdAt = previous.createdAt;
          this.setEntries(section, data, [...entries.filter((v) => v.id !== e.id), e]);
          if (section === "extensions") this.applyExtension(data, e, false);
        });
        return true;
      }
      if (action === "config_toggle_" + section || action === "config_remove_" + section) {
        await this.mutate((data) => {
          let entries = this.entries(section, data);
          const e = entries.find((v) => v.id === value);
          if (!e) throw new Error("configuration_entry_missing");
          if (action === "config_remove_" + section)
            entries = entries.filter((v) => v.id !== value);
          else {
            e.enabled = e.enabled === false;
            if (section === "actions") {
              e.userDisabled = !e.enabled;
              e.updatedAt = new Date().toISOString();
            }
            if (section === "providers") {
              const runtime = obj(obj(data.configuration).runtime),
                disabled = new Set(
                  Array.isArray(runtime.disabled_providers)
                    ? (runtime.disabled_providers as string[])
                    : [],
                );
              if (disabled.has(String(e.id))) disabled.delete(String(e.id));
              else disabled.add(String(e.id));
              runtime.disabled_providers = [...disabled];
              delete e.enabled;
            }
          }
          this.setEntries(section, data, entries);
          if (section === "extensions")
            this.applyExtension(data, e, action === "config_remove_" + section);
        });
        return true;
      }
    }
    if (action === "memory") {
      const b = this.ctx.button.bind(this.ctx),
        memory = list(obj(this.snapshot().data.defaults).memory);
      await this.ctx.menu(
        "💾 <b>Persistent Memory</b>\n\n" + memory.map((e) => esc(e.content)).join("\n"),
        [
          [b("＋ Remember", "config_memory_add")],
          ...memory
            .slice(0, 40)
            .map((e) => [
              b("Forget: " + String(e.content).slice(0, 40), "config_forget", String(e.id)),
            ]),
          [b("← Settings", "settings")],
        ],
      );
      return true;
    }
    if (action === "config_memory_add") {
      await this.ctx.prompt("config_remember", "Send a memory to remember globally, or /cancel.");
      return true;
    }
    if (action === "config_memory_forget") {
      await this.ctx.prompt(
        "config_forget",
        "Send the memory ID or exact memory text to forget, or /cancel.",
      );
      return true;
    }
    if (action === "config_remember" || action === "config_forget") {
      await this.mutate((data) => {
        const d = obj(data.defaults),
          memory = list(d.memory);
        data.defaults = d;
        const v = text(value, 4000);
        if (action === "config_remember") {
          if (memory.length >= 100) throw new Error("memory_limit");
          d.memory = [...memory, { id: crypto.randomUUID(), content: v }];
        } else {
          if (!memory.some((e) => e.id === v || e.content === v)) throw new Error("memory_missing");
          d.memory = memory.filter((e) => e.id !== v && e.content !== v);
        }
      });
      return true;
    }
    if (action === "topic_defaults" || action === "appearance" || action === "queue") {
      const b = this.ctx.button.bind(this.ctx),
        d = obj(obj(this.snapshot().data.defaults).topicDefaults);
      await this.ctx.menu("🧩 <b>Topic Defaults</b>", [
        ...Object.entries(OUTPUT_DEFAULTS).map(([key, fallback]) => [
          b(outputSettingLabel(key as OutputField, d[key] ?? fallback), "config_default", key),
        ]),
        [b("← Settings", "settings")],
      ]);
      return true;
    }
    if (action === "config_default") {
      if (!value || !Object.hasOwn(OUTPUT_DEFAULTS, value)) throw new Error("invalid_default");
      await this.mutate((data) => {
        const defaults = obj(data.defaults),
          d = obj(defaults.topicDefaults);
        data.defaults = defaults;
        defaults.topicDefaults = d;
        const previous = d[value] ?? OUTPUT_DEFAULTS[value as OutputField];
        d[value] =
          typeof previous === "boolean"
            ? !previous
            : value === "responseStreamingMode"
              ? previous === "off"
                ? "edit"
                : "off"
              : previous === "markdown"
                ? "raw"
                : "markdown";
        const c = obj(data.configuration),
          s = obj(c.settings);
        data.configuration = c;
        c.settings = s;
        s.topicDefaults = d;
      });
      return true;
    }
    if (action === "experimental") {
      const b = this.ctx.button.bind(this.ctx);
      await this.ctx.menu("🧪 <b>Experimental</b>", [
        [
          b(
            "Free Model Detection: " +
              (obj(obj(this.snapshot().data.configuration).settings)
                .experimentalFreeModelDetection === true
                ? "ON"
                : "OFF"),
            "config_free_detection",
          ),
        ],
        [b("← Settings", "settings")],
      ]);
      return true;
    }
    if (action === "config_free_detection") {
      await this.mutate((data) => {
        const c = obj(data.configuration),
          s = obj(c.settings);
        data.configuration = c;
        c.settings = s;
        s.experimentalFreeModelDetection = s.experimentalFreeModelDetection !== true;
      });
      return true;
    }
    return false;
  }
  private applyExtension(
    data: Record<string, unknown>,
    extension: Record<string, unknown>,
    removed: boolean,
  ): void {
    const r = obj(extension.resource),
      section = (
        {
          skill: "skills",
          mcp: "mcps",
          plugin: "plugins",
          "model-provider": "providers",
        } as Record<string, Section>
      )[String(r.kind)];
    if (!section) return;
    const key = r.skillName ?? r.serverName ?? r.specifier ?? r.providerId,
      entries = this.entries(section, data),
      entry = entries.find((e) => e.id === key);
    if (!entry) {
      if (removed) data.actions = list(data.actions).filter((a) => a.extensionId !== extension.id);
      return;
    }
    if (removed)
      this.setEntries(
        section,
        data,
        entries.filter((e) => e !== entry),
      );
    else {
      entry.enabled = extension.enabled !== false;
      this.setEntries(section, data, entries);
      if (section === "providers") {
        const runtime = obj(obj(data.configuration).runtime),
          disabled = new Set(
            Array.isArray(runtime.disabled_providers)
              ? (runtime.disabled_providers as string[])
              : [],
          );
        if (entry.enabled) disabled.delete(String(entry.id));
        else disabled.add(String(entry.id));
        runtime.disabled_providers = [...disabled];
      }
    }
    if (removed) data.actions = list(data.actions).filter((a) => a.extensionId !== extension.id);
  }
}
/** Call only after the parent has fenced and cleaned every Worker; commit with current revision. */
export function resetGlobalConfiguration(data: Record<string, unknown>): Record<string, unknown> {
  return {
    ...data,
    configuration: {
      runtime: {
        $schema: "https://opencode.ai/config.json",
        permission: obj(obj(data.configuration).runtime).permission,
        provider: {},
        mcp: {},
        plugin: [],
      },
      settings: {},
      extensions: [],
    },
    skills: [],
    actions: [],
    catalog: {},
    defaults: {},
    credentialReferences: [],
  };
}

/** Pure canonical projection for approved Core bridge operations. No I/O, vault, or legacy state. */
export async function applyGlobalConfigMutation(
  snapshot: Record<string, unknown>,
  type: string,
  resource: string,
  config: unknown,
): Promise<Record<string, unknown>> {
  let result = structuredClone(snapshot);
  const c = obj(config);
  const ui = new CloudConfigUi({
    store: { global: () => ({ data: result, revision: 0, hash: "" }) } as ControlStore,
    sql: {} as SqlDatabase,
    telegram: {} as CloudTelegram,
    commit: async (data) => {
      result = data;
    },
    button: (text) => ({ text, callback_data: "" }),
    prompt: async () => {},
    notice: async () => {},
    menu: async () => {},
  });
  const save = async (section: Section, value: Record<string, unknown>) => {
    await ui.handle("config_save_" + section, JSON.stringify(value));
  };
  const remove = async (section: Section, key: string) => {
    await ui.handle("config_remove_" + section, key);
  };
  if (/^skills\.(?:add|create|update)$/.test(type)) {
    const name = id(c.name ?? resource);
    let content: string;
    if (type === "skills.add" || c.content !== undefined) {
      text(c.content, 131072);
      content = c.content as string;
      const expected = c.contentHash ?? c.hash;
      if (typeof expected !== "string" || expected !== (await hash(content)))
        throw new Error("skill_content_hash_mismatch");
    } else {
      const description = text(c.description, 4096)
        .replace(/[\r\n]+/g, " ")
        .replace(/"/g, "'")
        .trim()
        .slice(0, 1024);
      const body = text(c.body, 131072).slice(0, 8000);
      content = `---\nname: ${name}\ndescription: "${description}"\n---\n\n${body}\n`;
    }
    await save("skills", { name, content });
  } else if (type === "skills.delete") await remove("skills", resource);
  else if (type === "extensions.ensure") await save("extensions", { ...c, id: c.id ?? resource });
  else if (type === "extensions.remove") await remove("extensions", resource);
  else if (type === "mcp.add")
    await save("mcps", { ...obj(c.config ?? c), id: c.name ?? resource });
  else if (type === "mcp.delete") await remove("mcps", resource);
  else if (type === "mcp.enable") {
    if (typeof c.enabled !== "boolean") throw new Error("invalid_mcp_enabled");
    const runtime = obj(obj(result.configuration).runtime),
      mcp = obj(runtime.mcp),
      server = obj(mcp[resource]);
    if (!Object.hasOwn(mcp, resource)) throw new Error("configuration_entry_missing");
    server.enabled = c.enabled;
    mcp[resource] = server;
  } else if (type === "mcp.rename") {
    const runtime = obj(obj(result.configuration).runtime),
      mcp = obj(runtime.mcp),
      newName = id(c.newName ?? c.name);
    if (!Object.hasOwn(mcp, resource)) throw new Error("configuration_entry_missing");
    if (Object.hasOwn(mcp, newName)) throw new Error("configuration_entry_exists");
    mcp[newName] = mcp[resource];
    delete mcp[resource];
    for (const extension of list(obj(result.configuration).extensions)) {
      const r = obj(extension.resource);
      if (r.kind === "mcp" && r.serverName === resource) r.serverName = newName;
    }
    for (const action of list(result.actions)) {
      const invocation = obj(action.invocation);
      if (invocation.kind === "mcp-tool" && invocation.server === resource)
        invocation.server = newName;
    }
  } else if (type === "mcp.sync") {
    const servers = Array.isArray(config)
      ? config
      : Array.isArray(c.servers)
        ? c.servers
        : undefined;
    if (!servers || servers.length > 100) throw new Error("invalid_mcp_sync");
    for (const raw of servers) {
      const server = obj(raw);
      await save("mcps", { ...obj(server.config ?? server), id: server.name ?? server.id });
    }
  } else if (type === "generated-actions.toggle") {
    if (typeof c.enabled !== "boolean") throw new Error("invalid_action_enabled");
    const action = list(result.actions).find((a) => a.id === resource);
    if (!action) throw new Error("configuration_entry_missing");
    action.enabled = c.enabled;
    action.userDisabled = !c.enabled;
    action.updatedAt = new Date().toISOString();
  } else if (type === "generated-actions.register" || type === "generated-actions.update") {
    const actions = Array.isArray(c.actions) ? c.actions : [c];
    if (actions.length > 100) throw new Error("action_limit");
    const owningExtension = extensionIdentity(resource),
      owner = list(obj(result.configuration).extensions).find((e) => e.id === owningExtension);
    if (!owner) throw new Error("action_extension_missing");
    const nextIds = new Set<string>();
    for (const raw of actions) {
      const action = obj(raw),
        key = id(action.id);
      if (nextIds.has(key)) throw new Error("duplicate_action_id");
      nextIds.add(key);
      if (action.extensionId !== undefined && action.extensionId !== owningExtension)
        throw new Error("action_owner_mismatch");
      const previous = list(result.actions).find((a) => a.id === key);
      if (previous && previous.extensionId !== owningExtension)
        throw new Error("action_owner_mismatch");
      const tool = text(action.tool, 128),
        invocation = validateGeneratedActionInvocation(
          action.invocation ?? { kind: "mcp-tool", tool },
        );
      const verb = text(action.action ?? key.split(".").at(-1), 128),
        userDisabled = previous?.userDisabled === true;
      await save("actions", {
        ...action,
        id: key,
        extensionId: owningExtension,
        tool,
        invocation,
        action: verb,
        category: action.category ?? "extension",
        risk: actionRisk(
          key,
          verb,
          tool +
            " " +
            invocation.tool +
            " " +
            (invocation.kind === "action-tool" ? invocation.actionValue : ""),
        ),
        enabled: !userDisabled,
      });
    }
    result.actions = list(result.actions).filter(
      (a) => a.extensionId !== owningExtension || nextIds.has(String(a.id)),
    );
  } else if (type === "generated-actions.remove") {
    const actions = list(result.actions);
    if (actions.some((a) => a.id === resource)) await remove("actions", resource);
    else result.actions = actions.filter((a) => a.extensionId !== resource);
  } else throw new Error("unsupported_global_mutation");
  return result;
}
