import { readPublicGlobalCatalog } from "../app/services/free-llm-catalog-service.js";
import { projectGlobalModelCatalog } from "../app/services/global-model-catalog-service.js";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { MANAGED_OPENCODE_PERMISSION_POLICY } from "../opencode/managed-policy.js";
import { getRuntimePaths } from "../runtime/paths.js";
import { getGlobalSkillsDir } from "../app/services/global-skill-path.js";
import { readAppState, transactAppState, type AppState } from "../app/stores/app-state-store.js";

export interface GlobalSnapshot {
  version: 1;
  revision: number;
  hash: string;
  configuration: Record<string, unknown>;
  skills: { name: string; hash: string; content: string }[];
  actions: unknown[];
  catalog: unknown;
  defaults: Record<string, unknown>;
  credentialReferences: unknown[];
}
export interface GlobalMutationInput {
  type: string;
  resource: string;
  actorTopicId: string;
  sessionId: string;
  configHash: string;
  approvalId?: string;
  receipt?: Record<string, unknown>;
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const hash = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
// Only these DTO fields can cross the Global boundary. Containers with arbitrary names
// are handled separately; unknown nested properties (including secrets) are discarded.
const fields = new Set(
  "id name kind type enabled userDisabled description purpose authType credentialId extensionId providerID modelID model provider capability attachment modalities input output toolCall toolCallVerified tool action category risk server actionArgument actionValue timeout language compactOutputMode showThinkingContent responseStreamingMode messageFormatMode showAssistantRunFooter sendDiffFileAttachments promptQueueEnabled variant general coding image stt experimentalFreeModelDetection freeSuffix freeModels paidByDefault confidence version configured missing auth scopes policy free verified npm specifier adapter serverName skillName providerId label config resource credentialSchemas transport invocation models providers favorite recent".split(
    " ",
  ),
);
function dto(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dto);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => fields.has(key))
        .map(([key, item]) => [key, dto(item)]),
    );
  return value;
}
function records(value: unknown): unknown[] {
  return Object.values(record(record(value).records)).map(dto);
}
async function loadSkills(): Promise<GlobalSnapshot["skills"]> {
  const root = getGlobalSkillsDir();
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const skills: GlobalSnapshot["skills"] = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, "SKILL.md");
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile()) throw new Error("Global skill must be a regular file");
      const content = await fs.readFile(file, "utf8");
      skills.push({ name: entry.name, content, hash: hash(content) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return skills;
}
/** Transport URLs never carry userinfo, query authentication, or fragments. */
function endpoint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}
function pluginSpecifier(value: unknown): string | undefined {
  if (typeof value !== "string" || /[\s\x00-\x1f]/u.test(value)) return undefined;
  if (/^(?:@[^/]+\/)?[^/@:]+@\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(value)) return value;
  const git = value.indexOf("git+https://");
  if (git < 0) return undefined;
  try {
    const url = new URL(value.slice(git + 4));
    if (
      url.username ||
      url.password ||
      url.search ||
      !/^#(?:v?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?|[a-fA-F0-9]{40})$/u.test(url.hash)
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}
function runtimeModel(value: unknown): Record<string, unknown> {
  const model = record(value);
  const modalities = record(model.modalities);
  const strings = (value: unknown, fallback: string[]): string[] =>
    Array.isArray(value)
      ? value.filter(
          (item): item is string =>
            typeof item === "string" && ["text", "image", "audio", "video", "pdf"].includes(item),
        )
      : fallback;
  const input = strings(modalities.input, ["text", "image"]);
  return {
    name: typeof model.name === "string" ? model.name : String(model.id),
    attachment:
      typeof model.attachment === "boolean"
        ? model.attachment
        : input.some((item) => item !== "text"),
    tool_call: model.toolCall === true && model.toolCallVerified === true,
    modalities: { input, output: strings(modalities.output, ["text"]) },
  };
}
/** Valid upstream OpenCode configuration; credential references require a Worker proxy adapter. */
export function materializeRuntimeConfiguration(state: AppState): Record<string, unknown> {
  const mcp: Record<string, unknown> = {};
  for (const candidate of Object.values(record(record(state.mcpServers).records))) {
    const server = record(candidate);
    const config = record(server.config);
    if (typeof server.name !== "string") continue;
    const common = {
      ...(typeof config.enabled === "boolean" ? { enabled: config.enabled } : {}),
      ...(typeof config.timeout === "number" && config.timeout > 0
        ? { timeout: config.timeout }
        : {}),
    };
    if (config.type === "remote") {
      const url = endpoint(config.url);
      if (url) mcp[server.name] = { type: "remote", url, ...common };
    } else if (
      config.type === "local" &&
      Array.isArray(config.command) &&
      config.command.length > 0 &&
      config.command.every(
        (arg) =>
          typeof arg === "string" &&
          !/[\x00-\x1f]|(?:api[-_]?key|token|password|secret|authorization|bearer|credential|--key|--header|--env|^-H$|^-u$|^-c$|^-e$|[A-Z_][A-Z0-9_]*=)/iu.test(
            arg,
          ),
      )
    ) {
      mcp[server.name] = { type: "local", command: [...config.command], ...common };
    }
  }
  const provider: Record<string, unknown> = {};
  const source = record(state.customProviders).providers;
  for (const candidate of Array.isArray(source) ? source : []) {
    const item = record(candidate);
    const baseURL = endpoint(item.baseURL);
    if (
      typeof item.id !== "string" ||
      !baseURL ||
      item.capability === "stt" ||
      item.id === "gemini-image"
    )
      continue;
    const models: Record<string, unknown> = {};
    for (const candidate of Array.isArray(item.models) ? item.models : []) {
      const model = record(candidate);
      if (typeof model.id === "string") models[model.id] = runtimeModel(model);
    }
    const reference = `model-provider:${item.id}:${typeof item.credentialId === "string" ? item.credentialId : "api-key"}`;
    provider[item.id] = {
      npm: "@ai-sdk/openai-compatible",
      name: typeof item.name === "string" ? item.name : item.id,
      options: { baseURL, apiKey: `bot-credential-proxy:${reference}` },
      models,
    };
  }
  const plugins = Object.values(record(record(state.extensions).records)).flatMap((candidate) => {
    const resource = record(record(candidate).resource);
    const specifier = resource.kind === "plugin" ? pluginSpecifier(resource.specifier) : undefined;
    if (resource.kind === "plugin" && !specifier)
      throw new Error("Global plugin must have a valid immutable specifier");
    return specifier ? [specifier] : [];
  });
  return {
    $schema: "https://opencode.ai/config.json",
    permission: MANAGED_OPENCODE_PERMISSION_POLICY,
    provider,
    mcp,
    ...(plugins.length ? { plugin: [...new Set(plugins)].sort() } : {}),
  };
}
export async function materializeGlobalSnapshot(state: AppState): Promise<GlobalSnapshot> {
  const settings = record(state.settings);
  const publicCatalog = await readPublicGlobalCatalog();
  const runtime = materializeRuntimeConfiguration(state);
  const runtimeProviders = record(runtime.provider);
  for (const item of publicCatalog.providers) {
    if (
      item.status !== "verified" ||
      item.integration !== "direct-openai" ||
      !item.enabledByDefault ||
      !item.baseURL ||
      !item.models.length
    )
      continue;
    const sourceId = item.runtimeId ?? item.id;
    const id = sourceId.startsWith("free-") ? sourceId : `free-${sourceId}`;
    const baseURL = endpoint(item.baseURL);
    if (!baseURL) throw new Error("Invalid public provider endpoint");
    const models = Object.fromEntries(
      item.models.map((model) => [
        model.id,
        {
          ...runtimeModel({ ...model, toolCallVerified: true }),
          ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
          ...(model.context || model.output
            ? {
                limit: {
                  ...(model.context ? { context: model.context } : {}),
                  ...(model.output ? { output: model.output } : {}),
                },
              }
            : {}),
        },
      ]),
    );
    runtimeProviders[id] = {
      npm: "@ai-sdk/openai-compatible",
      name: item.name,
      options: {
        baseURL,
        ...(item.auth.mode !== "none"
          ? { apiKey: `bot-credential-proxy:free-provider:${item.id}:public-auth` }
          : {}),
      },
      models,
    };
  }
  runtime.provider = runtimeProviders;
  const configuration: Record<string, unknown> = {
    runtime,
    settings: dto(settings),
    extensions: records(state.extensions),
    mcp: records(state.mcpServers),
    integrations: Object.fromEntries(
      Object.entries(record(state.integrations)).map(([name, item]) => [name, dto(item)]),
    ),
    providerFreePolicies: Object.fromEntries(
      Object.entries(record(record(state.providerFreePolicies).policies)).map(([name, item]) => [
        name,
        dto(item),
      ]),
    ),
  };
  const providers = record(state.customProviders);
  const snapshot: GlobalSnapshot = {
    version: 1,
    revision: 0,
    hash: "",
    configuration,
    skills: await loadSkills(),
    actions: records(state.generatedActions),
    catalog: {
      entries: projectGlobalModelCatalog(runtime, state),
      publicProviders: publicCatalog.providers.map((item) => ({
        id: item.id,
        runtimeId: item.runtimeId ?? item.id,
        name: item.name,
        status: item.status,
        integration: item.integration,
        enabledByDefault: item.enabledByDefault,
        auth: item.auth,
        models: item.models,
      })),
      customProviders: dto(providers),
      imageAi: dto(state.imageAi ?? {}),
      modelPreferences: dto(state.modelPreferences ?? {}),
    },
    defaults: {
      topicDefaults: dto(settings.topicDefaults ?? {}),
      defaultCapabilityModels: dto(settings.defaultCapabilityModels ?? {}),
      aiRoles: dto(state.aiRoles ?? {}),
    },
    credentialReferences: [],
  };
  const vaultEntries = record(record(state.credentialVault).entries);
  for (const candidate of Array.isArray(providers.providers) ? providers.providers : []) {
    const item = record(candidate);
    if (typeof item.id !== "string") continue;
    const credentialId = typeof item.credentialId === "string" ? item.credentialId : "api-key";
    const extensionId = `model-provider:${item.id}`;
    const id = hash(`${extensionId}\0${credentialId}`);
    const configured = Object.hasOwn(vaultEntries, id);
    snapshot.credentialReferences.push({
      id,
      extensionId,
      credentialId,
      configured,
      missing: !configured,
    });
  }
  for (const [id, entry] of Object.entries(record(record(state.credentialVault).entries))) {
    const metadata = record(record(entry).metadata);
    if (typeof metadata.extensionId === "string" && typeof metadata.credentialId === "string")
      snapshot.credentialReferences.push({
        id,
        extensionId: metadata.extensionId,
        credentialId: metadata.credentialId,
        configured: true,
      });
  }
  for (const id of Object.keys(record(record(state.mcpCredentials).records))) {
    const server=record(record(record(state.mcpServers).records)[id]);
    if(typeof server.name==="string")snapshot.credentialReferences.push({ id, kind: "mcp", capability: `mcp:${server.name}`, configured: true });
  }
  snapshot.credentialReferences.sort((a, b) => (canonicalJson(a) < canonicalJson(b) ? -1 : 1));
  return snapshot;
}
function contentHash(snapshot: GlobalSnapshot): string {
  const content = { ...snapshot } as Partial<GlobalSnapshot>;
  delete content.hash;
  delete content.revision;
  return hash(canonicalJson(content));
}
function snapshotHash(snapshot: GlobalSnapshot): string {
  const content = { ...snapshot } as Partial<GlobalSnapshot>;
  delete content.hash;
  return hash(canonicalJson(content));
}
export function validateGlobalSnapshot(value: unknown): GlobalSnapshot | undefined {
  if (value === undefined) return undefined;
  const item = record(value);
  if (
    item.version !== 1 ||
    !Number.isSafeInteger(item.revision) ||
    Number(item.revision) < 0 ||
    typeof item.hash !== "string" ||
    !Array.isArray(item.skills) ||
    !Array.isArray(item.actions) ||
    !Array.isArray(item.credentialReferences) ||
    !item.configuration ||
    !item.defaults
  )
    throw new Error("Global snapshot is invalid");
  const snapshot = value as GlobalSnapshot;
  if (snapshotHash(snapshot) !== snapshot.hash)
    throw new Error("Global snapshot integrity check failed");
  return snapshot;
}
const knownSnapshots = new Map<string, GlobalSnapshot>();
export async function revisionAppState(previous: AppState, next: AppState): Promise<AppState> {
  const prior = validateGlobalSnapshot(previous.globalSnapshot);
  const known = knownSnapshots.get(getRuntimePaths().appHome);
  if (
    known &&
    (!prior ||
      prior.revision < known.revision ||
      (prior.revision === known.revision && prior.hash !== known.hash))
  ) {
    throw new Error("Global snapshot would overwrite a known newer revision");
  }
  const snapshot = await materializeGlobalSnapshot(next);
  const previousContent = prior ?? (await materializeGlobalSnapshot(previous));
  const changed = contentHash(snapshot) !== contentHash(previousContent);
  snapshot.revision = (prior?.revision ?? 0) + (changed ? 1 : 0);
  snapshot.hash = snapshotHash(snapshot);
  return { ...next, globalSnapshot: changed || !prior ? snapshot : prior };
}
const listeners = new Set<(snapshot: GlobalSnapshot) => Promise<void>>();
export function onGlobalRevision(
  listener: (snapshot: GlobalSnapshot) => Promise<void>,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export async function broadcastGlobalRevision(previous: AppState, next: AppState): Promise<void> {
  const snapshot = validateGlobalSnapshot(next.globalSnapshot);
  if (!snapshot) return;
  knownSnapshots.set(getRuntimePaths().appHome, structuredClone(snapshot));
  if (record(previous.globalSnapshot).hash === snapshot.hash) return;
  await Promise.allSettled([...listeners].map((listener) => listener(structuredClone(snapshot))));
}
export async function readGlobalSnapshot(): Promise<GlobalSnapshot> {
  await transactAppState(async () => {});
  return structuredClone(validateGlobalSnapshot((await readAppState()).globalSnapshot)!);
}
export async function commitGlobalMutation(
  input: GlobalMutationInput,
  apply: () => Promise<void>,
): Promise<GlobalSnapshot> {
  return await transactAppState(apply, input);
}
