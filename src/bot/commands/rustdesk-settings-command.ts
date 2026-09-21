import { randomUUID } from "node:crypto";
import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { TopicScopedValue } from "../../app/services/topic-scoped-value.js";
import { getMainNavigationMessageId } from "../../app/stores/settings-store.js";
import {
  createRustDeskBridgeClientFromEnv,
  RUSTDESK_ACTIONS,
  RUSTDESK_BRIDGE_CONTRACT_VERSION,
  type RustDeskDevice,
  type RustDeskServerProfile,
  type RustDeskServerSelector,
  type RustDeskTemporaryAuthMode,
} from "../../app/services/rustdesk-bridge-service.js";
import { logger } from "../../utils/logger.js";

type ServerWizardStep = "name" | "id-server" | "relay" | "api" | "server-key";
type DeviceWizardStep = "name" | "rustdesk-id" | "server" | "force-relay" | "credential";
type TempWizardStep =
  | "rustdesk-id"
  | "server"
  | "id-server"
  | "relay"
  | "api"
  | "server-key"
  | "auth"
  | "credential";

interface ServerWizard {
  kind: "server";
  step: ServerWizardStep;
  messageId: number;
  id: string;
  editing: boolean;
  name?: string;
  idServer?: string;
  relayServer?: string;
  apiServer?: string;
  keyConfigured?: boolean;
}

interface DeviceWizard {
  kind: "device";
  step: DeviceWizardStep;
  messageId: number;
  id: string;
  editing: boolean;
  name?: string;
  rustdeskId?: string;
  serverProfileId?: string;
  forceRelay?: boolean;
  credentialConfigured?: boolean;
}

interface TempWizard {
  kind: "temporary";
  step: TempWizardStep;
  messageId: number;
  rustdeskId?: string;
  server?: RustDeskServerSelector;
  authMode?: RustDeskTemporaryAuthMode;
  oneTimeIdServer?: string;
  oneTimeRelay?: string;
  oneTimeApi?: string;
  oneTimeServerKey?: string;
  connectionId?: string;
  credentialRequestId?: string;
}

interface ConnectionCredentialWizard {
  kind: "connection-credential";
  messageId: number;
  connectionId: string;
  credentialRequestId: string;
}

type RustDeskWizard = ServerWizard | DeviceWizard | TempWizard | ConnectionCredentialWizard;
const wizard = new TopicScopedValue<RustDeskWizard>();

function callbackMessageId(ctx: Context): number | null {
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
  if (typeof chatId === "number") {
    const canonical = getMainNavigationMessageId(chatId);
    if (typeof canonical === "number" && Number.isInteger(canonical) && canonical > 0) {
      return canonical;
    }
  }
  const message = ctx.callbackQuery?.message;
  if (!message || !("message_id" in message)) return null;
  return typeof message.message_id === "number" ? message.message_id : null;
}

function shortId(prefix: "srv" | "dev"): string {
  return `${prefix}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function cleanOptional(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function responseArray<T>(value: unknown, key: string): T[] {
  const item = record(value)[key];
  return Array.isArray(item) ? (item as T[]) : [];
}

function serverFromResponse(value: unknown): RustDeskServerProfile | null {
  const item = record(value).server;
  return item && typeof item === "object" && !Array.isArray(item)
    ? (item as RustDeskServerProfile)
    : null;
}

function deviceFromResponse(value: unknown): RustDeskDevice | null {
  const item = record(value).device;
  return item && typeof item === "object" && !Array.isArray(item)
    ? (item as RustDeskDevice)
    : null;
}

interface RustDeskConnectionView {
  connectionId?: string;
  status?: string;
  credentialRequestId?: string;
  credentialKind?: string;
  error?: string;
}

function connectionFromResponse(value: unknown): RustDeskConnectionView {
  const root = record(value);
  const nested = record(root.connection);
  const source = Object.keys(nested).length > 0 ? nested : root;
  return {
    connectionId: typeof source.connectionId === "string" ? source.connectionId : undefined,
    status: typeof source.status === "string" ? source.status : undefined,
    credentialRequestId:
      typeof source.credentialRequestId === "string" ? source.credentialRequestId : undefined,
    credentialKind:
      typeof source.credentialKind === "string" ? source.credentialKind : undefined,
    error: typeof source.error === "string" && source.error.trim() ? source.error.trim() : undefined,
  };
}

function isMessageNotModified(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("message is not modified");
}

const SETTLED_CONNECTION_STATUSES = new Set([
  "connected",
  "failed",
  "waiting_remote_approval",
  "credential_required",
  "disconnected",
]);

async function settleConnectionStatus(
  client: ReturnType<typeof createRustDeskBridgeClientFromEnv>,
  connection: RustDeskConnectionView,
): Promise<RustDeskConnectionView> {
  if (!connection.connectionId || SETTLED_CONNECTION_STATUSES.has(connection.status ?? "")) {
    return connection;
  }
  let current = connection;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 350));
    const livePayload = await client.execute({
      action: "connection.status",
      connectionId: connection.connectionId,
    });
    const live = connectionFromResponse(livePayload);
    current = {
      ...current,
      ...live,
      connectionId: live.connectionId ?? current.connectionId,
      status: live.status ?? current.status,
    };
    if (SETTLED_CONNECTION_STATUSES.has(current.status ?? "")) break;
  }
  return current;
}

async function deleteInput(ctx: Context): Promise<void> {
  const messageId = ctx.message?.message_id;
  if (ctx.chat?.id && messageId) {
    await ctx.api.deleteMessage(ctx.chat.id, messageId).catch(() => {});
  }
}

async function edit(
  ctx: Context,
  messageId: number | null | undefined,
  text: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
  const targetMessageId = callbackMessageId(ctx) ?? messageId;
  if (typeof chatId !== "number" || typeof targetMessageId !== "number") {
    throw new Error("General Panel is unavailable; reopen Settings from the pinned Main panel");
  }
  try {
    await ctx.api.editMessageText(chatId, targetMessageId, text, { reply_markup: keyboard });
  } catch (error) {
    if (isMessageNotModified(error)) return;
    throw error;
  }
}

function navigationKeyboard(back = "integration:rustdesk"): InlineKeyboard {
  return new InlineKeyboard()
    .text("← Back", back)
    .text("🏠 Home", "main:home");
}

function cancelKeyboard(back = "integration:rustdesk"): InlineKeyboard {
  return new InlineKeyboard()
    .text("❌ Cancel", "integration:rd:cancel")
    .text("← Back", back);
}

async function listServers(): Promise<RustDeskServerProfile[]> {
  const payload = await createRustDeskBridgeClientFromEnv().execute({ action: "servers.list" });
  return responseArray<RustDeskServerProfile>(payload, "servers");
}

async function listDevices(): Promise<RustDeskDevice[]> {
  const payload = await createRustDeskBridgeClientFromEnv().execute({ action: "devices.list" });
  return responseArray<RustDeskDevice>(payload, "devices");
}

export function isRustDeskSettingsWizardActive(): boolean {
  return Boolean(wizard.get());
}

export function clearRustDeskSettingsWizard(): void {
  wizard.clear();
}

export async function showRustDeskIntegrationMenu(ctx: Context): Promise<void> {
  let configured = true;
  let healthy = false;
  let controlPlaneConfigured = false;
  let contractVersion: number | null = null;
  let servers = 0;
  let devices = 0;
  let actionSurface: "matched" | "mismatch" | "unknown" = "unknown";

  try {
    const client = createRustDeskBridgeClientFromEnv();
    const [health, serverPayload, devicePayload] = await Promise.all([
      client.execute({ action: "bridge.health" }),
      client.execute({ action: "servers.list" }),
      client.execute({ action: "devices.list" }),
    ]);
    const healthRecord = record(health);
    healthy = healthRecord.ok === true;
    controlPlaneConfigured = healthRecord.controlPlaneConfigured === true;
    contractVersion =
      typeof healthRecord.contractVersion === "number" ? healthRecord.contractVersion : null;
    servers = responseArray(serverPayload, "servers").length;
    devices = responseArray(devicePayload, "devices").length;
    const bridgeActions = Array.isArray(healthRecord.actions)
      ? healthRecord.actions.filter((value): value is string => typeof value === "string").sort()
      : null;
    if (bridgeActions) {
      const modelActions = [...RUSTDESK_ACTIONS].sort();
      actionSurface =
        bridgeActions.length === modelActions.length &&
        bridgeActions.every((value, index) => value === modelActions[index])
          ? "matched"
          : "mismatch";
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    configured = !message.includes("RUSTDESK_BRIDGE_URL");
    if (configured) logger.warn("[Integrations] RustDesk bridge summary failed:", error);
  }

  const status = !configured
    ? "⚪ Not configured"
    : healthy
      ? "🟢 Bridge online"
      : "🔴 Bridge unavailable";
  const keyboard = new InlineKeyboard()
    .text("🖥 Devices", "integration:rd:devices")
    .text("🌐 Server Profiles", "integration:rd:servers").row()
    .text("⚡ Temporary Connection", "integration:rd:temp").row()
    .text("🔄 Refresh", "integration:rustdesk:refresh").row()
    .text("← Integrations", "integration:menu")
    .text("🏠 Home", "main:home");

  const lines = [
    "🖥️ RustDesk",
    "",
    "Status: " + status,
    "Server profiles: " + servers,
    "Permanent devices: " + devices,
    "Secure control plane: " + (controlPlaneConfigured ? "Ready" : "Not ready"),
    "Bridge contract: " +
      (contractVersion === RUSTDESK_BRIDGE_CONTRACT_VERSION
        ? `v${contractVersion} · matched`
        : contractVersion === null
          ? `unknown · expected v${RUSTDESK_BRIDGE_CONTRACT_VERSION}`
          : `v${contractVersion} · expected v${RUSTDESK_BRIDGE_CONTRACT_VERSION}`),
    "Model action surface: " +
      (actionSurface === "matched"
        ? "matched ✅"
        : actionSurface === "mismatch"
          ? "MISMATCH ❌"
          : "unknown"),
    "",
    "🔐 Passwords, 2FA codes, tokens, and private server keys are never shown here or sent to the AI model.",
  ];
  if (!configured) {
    lines.push("", "RustDesk Core is not available in the trusted runtime.");
  } else {
    lines.push("", "Saved server/device inventory is owned by the RustDesk Bridge control plane.");
  }

  await edit(ctx, callbackMessageId(ctx), lines.join("\n"), keyboard);
}

async function showServersMenu(ctx: Context, notice?: string): Promise<void> {
  const servers = await listServers();
  const keyboard = new InlineKeyboard().text("➕ Add Self-hosted Server", "integration:rd:s:add").row();
  for (const server of servers) {
    const icon = server.kind === "public" ? "🌍" : "🌐";
    keyboard.text(`${icon} ${server.name}`, `integration:rd:s:view:${server.id}`).row();
  }
  keyboard.text("← RustDesk", "integration:rustdesk").text("🏠 Home", "main:home");
  const text = [
    notice,
    "🌐 RustDesk Server Profiles",
    "",
    "RustDesk Public is built in. Saved self-hosted profiles may include an ID server, relay, API endpoint, and an optional private key kept only in the Bridge secret store.",
  ].filter(Boolean).join("\n\n");
  await edit(ctx, callbackMessageId(ctx), text, keyboard);
}

async function showDevicesMenu(ctx: Context, notice?: string): Promise<void> {
  const devices = await listDevices();
  const keyboard = new InlineKeyboard().text("➕ Add Permanent Device", "integration:rd:d:add").row();
  for (const device of devices) {
    keyboard
      .text(`🖥 ${device.name ?? device.rustdeskId ?? device.id}`, `integration:rd:d:view:${device.id}`)
      .row();
  }
  keyboard.text("← RustDesk", "integration:rustdesk").text("🏠 Home", "main:home");
  const text = [
    notice,
    "🖥 RustDesk Permanent Devices",
    "",
    devices.length
      ? "Select a device to connect, edit, or remove it."
      : "No permanent devices are saved yet.",
  ].filter(Boolean).join("\n\n");
  await edit(ctx, callbackMessageId(ctx), text, keyboard);
}

async function showServerDetail(ctx: Context, id: string, notice?: string): Promise<void> {
  const payload = await createRustDeskBridgeClientFromEnv().execute({
    action: "servers.get",
    serverProfileId: id,
  });
  const server = serverFromResponse(payload);
  if (!server) throw new Error("RustDesk Bridge returned an invalid server profile");
  const keyboard = new InlineKeyboard().text("🧪 Test", `integration:rd:s:test:${id}`);
  if (server.kind !== "public") {
    keyboard.text("✏️ Edit", `integration:rd:s:edit:${id}`).row();
    keyboard.text("🗑 Delete", `integration:rd:s:delete:${id}`).row();
  } else {
    keyboard.row();
  }
  keyboard.text("← Server Profiles", "integration:rd:servers").text("🏠 Home", "main:home");
  const text = [
    notice,
    `🌐 ${server.name}`,
    "",
    `ID: ${server.id}`,
    `Type: ${server.kind === "public" ? "RustDesk Public" : "Saved self-hosted"}`,
    server.idServer ? `ID server: ${server.idServer}` : undefined,
    server.relayServer ? `Relay: ${server.relayServer}` : undefined,
    server.apiServer ? `API: ${server.apiServer}` : undefined,
    `Private key: ${server.keyConfigured ? "Configured 🔐" : "Not configured"}`,
  ].filter(Boolean).join("\n");
  await edit(ctx, callbackMessageId(ctx), text, keyboard);
}

async function showDeviceDetail(ctx: Context, id: string, notice?: string): Promise<void> {
  const payload = await createRustDeskBridgeClientFromEnv().execute({
    action: "devices.get",
    deviceId: id,
  });
  const device = deviceFromResponse(payload);
  if (!device) throw new Error("RustDesk Bridge returned an invalid device");
  const keyboard = new InlineKeyboard()
    .text("🔌 Connect", `integration:rd:d:connect:${id}`)
    .text("✏️ Edit", `integration:rd:d:edit:${id}`).row()
    .text("🗑 Delete", `integration:rd:d:delete:${id}`).row()
    .text("← Devices", "integration:rd:devices")
    .text("🏠 Home", "main:home");
  const text = [
    notice,
    `🖥 ${device.name ?? device.id}`,
    "",
    `RustDesk ID: ${device.rustdeskId ?? "Unknown"}`,
    `Server profile: ${device.serverProfileId ?? "Unknown"}`,
    `Permanent password: ${device.credentialConfigured ? "Configured 🔐" : "Missing"}`,
    device.online === true ? "Online: Yes" : device.online === false ? "Online: No" : undefined,
  ].filter(Boolean).join("\n");
  await edit(ctx, callbackMessageId(ctx), text, keyboard);
}

async function showServerChoice(ctx: Context, messageId: number, back: string): Promise<void> {
  const servers = await listServers();
  const keyboard = new InlineKeyboard();
  for (const server of servers) {
    keyboard.text(server.name, `integration:rd:w:server:${server.id}`).row();
  }
  keyboard.text("❌ Cancel", "integration:rd:cancel").text("← Back", back);
  await edit(ctx, messageId, "Choose the RustDesk server profile:", keyboard);
}

async function showTempServerChoice(ctx: Context, messageId: number): Promise<void> {
  const servers = await listServers();
  const keyboard = new InlineKeyboard();
  for (const server of servers) {
    keyboard.text(server.name, `integration:rd:w:tserver:${server.id}`).row();
  }
  keyboard.text("🧭 One-time Custom", "integration:rd:w:tserver:custom").row();
  keyboard.text("❌ Cancel", "integration:rd:cancel").text("← RustDesk", "integration:rustdesk");
  await edit(ctx, messageId, "Temporary connection · choose server routing:", keyboard);
}

async function showAuthChoice(ctx: Context, messageId: number): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text("👆 Manual approval", "integration:rd:w:auth:manual-approval").row()
    .text("🔐 Temporary password", "integration:rd:w:auth:temporary-password").row()
    .text("🔐 Password OR approval", "integration:rd:w:auth:password-or-approval").row()
    .text("❌ Cancel", "integration:rd:cancel");
  await edit(ctx, messageId, "Temporary connection · choose authentication:", keyboard);
}

function wizardValue(text: string, current?: string): string | undefined {
  if (text === "-") return current;
  return cleanOptional(text);
}

async function finishToRustDesk(ctx: Context, messageId: number, notice: string): Promise<void> {
  clearRustDeskSettingsWizard();
  await edit(
    ctx,
    messageId,
    notice + "\n\nOpen RustDesk settings to continue.",
    navigationKeyboard("integration:rustdesk"),
  );
}

async function connectTemporary(ctx: Context, state: TempWizard): Promise<void> {
  if (!state.rustdeskId || !state.server || !state.authMode) {
    throw new Error("Temporary connection wizard is incomplete");
  }
  const client = createRustDeskBridgeClientFromEnv();
  const payload = await client.connectTemporaryFromSettings({
    rustdeskId: state.rustdeskId,
    server: state.server,
    authMode: state.authMode,
    serverKey: state.oneTimeServerKey,
  });
  const connection = connectionFromResponse(payload);
  const connectionId = connection.connectionId;
  const status = connection.status ?? "connecting";
  const credentialRequestId = connection.credentialRequestId;

  if (status === "credential_required" && connectionId && credentialRequestId) {
    state.step = "credential";
    state.connectionId = connectionId;
    state.credentialRequestId = credentialRequestId;
    wizard.set(state);
    await edit(
      ctx,
      state.messageId,
      "🔐 Temporary RustDesk credential required\n\nSend the password as your next message. It will be deleted immediately and submitted directly to the Bridge control plane.",
      cancelKeyboard("integration:rd:temp"),
    );
    return;
  }

  await finishToRustDesk(
    ctx,
    state.messageId,
    `✅ Temporary connection created\nConnection: ${connectionId ?? "pending"}\nStatus: ${status}`,
  );
}

export async function handleRustDeskSettingsCallback(ctx: Context): Promise<boolean> {
  const data = ctx.callbackQuery?.data ?? "";
  if (data !== "integration:rustdesk" && data !== "integration:rustdesk:refresh" && !data.startsWith("integration:rd:")) {
    return false;
  }
  await ctx.answerCallbackQuery().catch(() => {});

  try {
    if (data === "integration:rustdesk" || data === "integration:rustdesk:refresh") {
      clearRustDeskSettingsWizard();
      await showRustDeskIntegrationMenu(ctx);
      return true;
    }
    if (data === "integration:rd:cancel") {
      clearRustDeskSettingsWizard();
      await showRustDeskIntegrationMenu(ctx);
      return true;
    }
    if (data === "integration:rd:servers") {
      clearRustDeskSettingsWizard();
      await showServersMenu(ctx);
      return true;
    }
    if (data === "integration:rd:devices") {
      clearRustDeskSettingsWizard();
      await showDevicesMenu(ctx);
      return true;
    }
    if (data === "integration:rd:temp") {
      const messageId = callbackMessageId(ctx);
      if (messageId === null) return true;
      wizard.set({ kind: "temporary", step: "rustdesk-id", messageId });
      await edit(
        ctx,
        messageId,
        "⚡ Temporary RustDesk Connection\n\n1/3 · Send the RustDesk peer ID.",
        cancelKeyboard(),
      );
      return true;
    }

    if (data === "integration:rd:s:add") {
      const messageId = callbackMessageId(ctx);
      if (messageId === null) return true;
      wizard.set({
        kind: "server",
        step: "name",
        messageId,
        id: shortId("srv"),
        editing: false,
      });
      await edit(ctx, messageId, "➕ Self-hosted RustDesk Server\n\n1/5 · Profile name", cancelKeyboard("integration:rd:servers"));
      return true;
    }
    if (data.startsWith("integration:rd:s:view:")) {
      await showServerDetail(ctx, data.slice("integration:rd:s:view:".length));
      return true;
    }
    if (data.startsWith("integration:rd:s:test:")) {
      const id = data.slice("integration:rd:s:test:".length);
      const payload = await createRustDeskBridgeClientFromEnv().execute({
        action: "servers.test",
        serverProfileId: id,
      });
      const result = record(payload);
      await showServerDetail(
        ctx,
        id,
        `🧪 Server test: ${result.ok === true ? "reachable/validated" : "completed"}`,
      );
      return true;
    }
    if (data.startsWith("integration:rd:s:edit:")) {
      const id = data.slice("integration:rd:s:edit:".length);
      const payload = await createRustDeskBridgeClientFromEnv().execute({
        action: "servers.get",
        serverProfileId: id,
      });
      const server = serverFromResponse(payload);
      const messageId = callbackMessageId(ctx);
      if (!server || server.kind === "public" || messageId === null) return true;
      wizard.set({
        kind: "server",
        step: "name",
        messageId,
        id: server.id,
        editing: true,
        name: server.name,
        idServer: server.idServer,
        relayServer: server.relayServer,
        apiServer: server.apiServer,
        keyConfigured: server.keyConfigured,
      });
      await edit(
        ctx,
        messageId,
        `✏️ Edit ${server.name}\n\n1/5 · Profile name\nCurrent: ${server.name}\nSend a new value or - to keep it.`,
        cancelKeyboard("integration:rd:servers"),
      );
      return true;
    }
    if (data.startsWith("integration:rd:s:delete:")) {
      const id = data.slice("integration:rd:s:delete:".length);
      const messageId = callbackMessageId(ctx);
      if (messageId === null) return true;
      const keyboard = new InlineKeyboard()
        .text("⚠️ Delete", `integration:rd:s:delete-confirm:${id}`)
        .text("Cancel", `integration:rd:s:view:${id}`);
      await edit(ctx, messageId, "Delete this saved RustDesk server profile? Devices referencing it will block deletion.", keyboard);
      return true;
    }
    if (data.startsWith("integration:rd:s:delete-confirm:")) {
      const id = data.slice("integration:rd:s:delete-confirm:".length);
      await createRustDeskBridgeClientFromEnv().deleteServerProfile(id);
      await showServersMenu(ctx, "✅ Server profile deleted.");
      return true;
    }

    if (data === "integration:rd:d:add") {
      const messageId = callbackMessageId(ctx);
      if (messageId === null) return true;
      wizard.set({
        kind: "device",
        step: "name",
        messageId,
        id: shortId("dev"),
        editing: false,
      });
      await edit(ctx, messageId, "➕ Permanent RustDesk Device\n\n1/4 · Device name", cancelKeyboard("integration:rd:devices"));
      return true;
    }
    if (data.startsWith("integration:rd:d:view:")) {
      await showDeviceDetail(ctx, data.slice("integration:rd:d:view:".length));
      return true;
    }
    if (data.startsWith("integration:rd:d:edit:")) {
      const id = data.slice("integration:rd:d:edit:".length);
      const payload = await createRustDeskBridgeClientFromEnv().execute({
        action: "devices.get",
        deviceId: id,
      });
      const device = deviceFromResponse(payload);
      const messageId = callbackMessageId(ctx);
      if (!device || messageId === null) return true;
      wizard.set({
        kind: "device",
        step: "name",
        messageId,
        id: device.id,
        editing: true,
        name: device.name,
        rustdeskId: device.rustdeskId,
        serverProfileId: device.serverProfileId,
        credentialConfigured: device.credentialConfigured,
      });
      await edit(
        ctx,
        messageId,
        `✏️ Edit ${device.name ?? device.id}\n\n1/4 · Device name\nCurrent: ${device.name ?? "(none)"}\nSend a new value or - to keep it.`,
        cancelKeyboard("integration:rd:devices"),
      );
      return true;
    }
    if (data.startsWith("integration:rd:d:delete:")) {
      const id = data.slice("integration:rd:d:delete:".length);
      const messageId = callbackMessageId(ctx);
      if (messageId === null) return true;
      const keyboard = new InlineKeyboard()
        .text("⚠️ Delete", `integration:rd:d:delete-confirm:${id}`)
        .text("Cancel", `integration:rd:d:view:${id}`);
      await edit(ctx, messageId, "Delete this permanent RustDesk device and its Bridge-managed password?", keyboard);
      return true;
    }
    if (data.startsWith("integration:rd:d:delete-confirm:")) {
      const id = data.slice("integration:rd:d:delete-confirm:".length);
      await createRustDeskBridgeClientFromEnv().deleteDevice(id);
      await showDevicesMenu(ctx, "✅ Device deleted.");
      return true;
    }
    if (data.startsWith("integration:rd:d:connect:")) {
      const id = data.slice("integration:rd:d:connect:".length);
      const client = createRustDeskBridgeClientFromEnv();
      const payload = await client.executeAuthorized(
        { action: "devices.connect", deviceId: id },
        async () => {},
      );
      let connection = connectionFromResponse(payload);
      try {
        connection = await settleConnectionStatus(client, connection);
      } catch (error) {
        logger.warn("[RustDeskSettings] Connection status polling failed:", error);
      }
      const status = connection.status ?? "connecting";
      const connectionId = connection.connectionId;
      const credentialRequestId = connection.credentialRequestId;
      if (status === "credential_required" && connectionId && credentialRequestId) {
        const messageId = callbackMessageId(ctx);
        if (messageId !== null) {
          wizard.set({
            kind: "connection-credential",
            messageId,
            connectionId,
            credentialRequestId,
          });
          await edit(
            ctx,
            messageId,
            "🔐 RustDesk credential/2FA required\n\nSend it as your next message. It will be deleted immediately and sent only to the Bridge control plane.",
            cancelKeyboard("integration:rd:devices"),
          );
        }
        return true;
      }
      const detail = [
        `✅ Connection · ${status}`,
        connectionId ? `Connection: ${connectionId}` : undefined,
        connection.error ? `Error: ${connection.error}` : undefined,
      ].filter(Boolean).join("\n");
      await showDeviceDetail(ctx, id, detail);
      return true;
    }

    if (data.startsWith("integration:rd:w:server:")) {
      const state = wizard.get();
      if (!state || state.kind !== "device") return true;
      state.serverProfileId = data.slice("integration:rd:w:server:".length);
      state.step = "force-relay";
      wizard.set(state);
      const keyboard = new InlineKeyboard()
        .text("No", "integration:rd:w:relay:no")
        .text("Yes", "integration:rd:w:relay:yes").row()
        .text("❌ Cancel", "integration:rd:cancel");
      await edit(ctx, state.messageId, "Force relay for this permanent device?", keyboard);
      return true;
    }
    if (data.startsWith("integration:rd:w:relay:")) {
      const state = wizard.get();
      if (!state || state.kind !== "device") return true;
      state.forceRelay = data.endsWith(":yes");
      state.step = "credential";
      wizard.set(state);
      await edit(
        ctx,
        state.messageId,
        state.editing && state.credentialConfigured
          ? "🔐 Permanent RustDesk password\n\nSend a new password, or send - to keep the existing Bridge-managed password."
          : "🔐 Permanent RustDesk password\n\nSend the password. The Telegram message will be deleted immediately and the password is stored only by the Bridge control plane.",
        cancelKeyboard("integration:rd:devices"),
      );
      return true;
    }

    if (data.startsWith("integration:rd:w:tserver:")) {
      const state = wizard.get();
      if (!state || state.kind !== "temporary") return true;
      const selected = data.slice("integration:rd:w:tserver:".length);
      if (selected === "custom") {
        state.step = "id-server";
        wizard.set(state);
        await edit(ctx, state.messageId, "One-time custom server · send ID/rendezvous server:", cancelKeyboard("integration:rd:temp"));
      } else if (selected === "rustdesk-public") {
        state.server = { kind: "public" };
        state.step = "auth";
        wizard.set(state);
        await showAuthChoice(ctx, state.messageId);
      } else {
        state.server = { kind: "saved-custom", serverProfileId: selected };
        state.step = "auth";
        wizard.set(state);
        await showAuthChoice(ctx, state.messageId);
      }
      return true;
    }
    if (data.startsWith("integration:rd:w:auth:")) {
      const state = wizard.get();
      if (!state || state.kind !== "temporary") return true;
      state.authMode = data.slice("integration:rd:w:auth:".length) as RustDeskTemporaryAuthMode;
      wizard.set(state);
      await connectTemporary(ctx, state);
      return true;
    }

    return true;
  } catch (error) {
    logger.error("[RustDeskSettings] callback failed:", error);
    await ctx.answerCallbackQuery({
      text: error instanceof Error ? error.message.slice(0, 180) : "RustDesk operation failed",
      show_alert: true,
    }).catch(() => {});
    return true;
  }
}

export async function handleRustDeskSettingsMessage(ctx: Context): Promise<boolean> {
  const state = wizard.get();
  const text = ctx.message?.text?.trim();
  if (!state || !text || !ctx.chat?.id) return false;

  try {
    if (state.kind === "server") {
      await deleteInput(ctx);
      if (state.step === "name") {
        state.name = wizardValue(text, state.name);
        if (!state.name) throw new Error("Server profile name is required");
        state.step = "id-server";
        wizard.set(state);
        await edit(ctx, state.messageId, `2/5 · ID/rendezvous server${state.idServer ? `\nCurrent: ${state.idServer}` : ""}\nSend a value or - to keep current.`, cancelKeyboard("integration:rd:servers"));
        return true;
      }
      if (state.step === "id-server") {
        state.idServer = wizardValue(text, state.idServer);
        if (!state.idServer) throw new Error("ID server is required");
        state.step = "relay";
        wizard.set(state);
        await edit(ctx, state.messageId, `3/5 · Relay server\nCurrent: ${state.relayServer ?? "(none)"}\nSend a value, 'none' to clear, or - to keep.`, cancelKeyboard("integration:rd:servers"));
        return true;
      }
      if (state.step === "relay") {
        state.relayServer = text.toLowerCase() === "none" ? undefined : wizardValue(text, state.relayServer);
        state.step = "api";
        wizard.set(state);
        await edit(ctx, state.messageId, `4/5 · API server (optional)\nCurrent: ${state.apiServer ?? "(none)"}\nSend a value, 'none' to clear, or - to keep.`, cancelKeyboard("integration:rd:servers"));
        return true;
      }
      if (state.step === "api") {
        state.apiServer = text.toLowerCase() === "none" ? undefined : wizardValue(text, state.apiServer);
        state.step = "server-key";
        wizard.set(state);
        await edit(
          ctx,
          state.messageId,
          state.keyConfigured
            ? "5/5 · Private server key\nSend a new key, - to keep the existing key, or 'none' to remove it."
            : "5/5 · Private server key (optional)\nSend the key, or send - to save without a key. This message is deleted immediately.",
          cancelKeyboard("integration:rd:servers"),
        );
        return true;
      }

      const clearServerKey = text.toLowerCase() === "none";
      const serverKey = text === "-" || clearServerKey ? undefined : text;
      await createRustDeskBridgeClientFromEnv().upsertServerProfile({
        id: state.id,
        name: state.name!,
        idServer: state.idServer!,
        relayServer: state.relayServer,
        apiServer: state.apiServer,
        serverKey,
        clearServerKey,
      });
      clearRustDeskSettingsWizard();
      await showServersMenu(ctx, state.editing ? "✅ Server profile updated." : "✅ Server profile added.");
      return true;
    }

    if (state.kind === "device") {
      await deleteInput(ctx);
      if (state.step === "name") {
        state.name = wizardValue(text, state.name);
        if (!state.name) throw new Error("Device name is required");
        state.step = "rustdesk-id";
        wizard.set(state);
        await edit(ctx, state.messageId, `2/4 · RustDesk ID${state.rustdeskId ? `\nCurrent: ${state.rustdeskId}` : ""}\nSend a value or - to keep current.`, cancelKeyboard("integration:rd:devices"));
        return true;
      }
      if (state.step === "rustdesk-id") {
        state.rustdeskId = wizardValue(text, state.rustdeskId);
        if (!state.rustdeskId) throw new Error("RustDesk ID is required");
        state.step = "server";
        wizard.set(state);
        await showServerChoice(ctx, state.messageId, "integration:rd:devices");
        return true;
      }
      if (state.step !== "credential") return true;

      const keepCredential = text === "-" && state.editing && state.credentialConfigured;
      if (text === "-" && !keepCredential) throw new Error("A permanent password is required for a new device");
      await createRustDeskBridgeClientFromEnv().upsertDevice({
        id: state.id,
        name: state.name,
        rustdeskId: state.rustdeskId!,
        serverProfileId: state.serverProfileId!,
        forceRelay: state.forceRelay ?? false,
        credential: keepCredential ? undefined : text,
      });
      clearRustDeskSettingsWizard();
      await showDevicesMenu(ctx, state.editing ? "✅ Device updated." : "✅ Permanent device added.");
      return true;
    }

    if (state.kind === "temporary") {
      await deleteInput(ctx);
      if (state.step === "rustdesk-id") {
        state.rustdeskId = text;
        state.step = "server";
        wizard.set(state);
        await showTempServerChoice(ctx, state.messageId);
        return true;
      }
      if (state.step === "id-server") {
        state.oneTimeIdServer = text;
        state.step = "relay";
        wizard.set(state);
        await edit(ctx, state.messageId, "One-time custom server · relay server (send - for none):", cancelKeyboard("integration:rd:temp"));
        return true;
      }
      if (state.step === "relay") {
        state.oneTimeRelay = text === "-" ? undefined : text;
        state.step = "api";
        wizard.set(state);
        await edit(ctx, state.messageId, "One-time custom server · API server (send - for none):", cancelKeyboard("integration:rd:temp"));
        return true;
      }
      if (state.step === "api") {
        state.oneTimeApi = text === "-" ? undefined : text;
        state.step = "server-key";
        wizard.set(state);
        await edit(
          ctx,
          state.messageId,
          "One-time custom server · private server key (send - for none). If supplied, this message is deleted immediately and the key is sent only to the Bridge control plane.",
          cancelKeyboard("integration:rd:temp"),
        );
        return true;
      }
      if (state.step === "server-key") {
        state.oneTimeServerKey = text === "-" ? undefined : text;
        state.server = {
          kind: "one-time-custom",
          idServer: state.oneTimeIdServer!,
          relayServer: state.oneTimeRelay,
          apiServer: state.oneTimeApi,
        };
        state.step = "auth";
        wizard.set(state);
        await showAuthChoice(ctx, state.messageId);
        return true;
      }
      if (state.step === "credential") {
        if (!state.credentialRequestId) throw new Error("RustDesk credential request expired");
        const response = await createRustDeskBridgeClientFromEnv().submitCredential({
          credentialRequestId: state.credentialRequestId,
          credential: text,
          trustThisDevice: false,
        });
        await finishToRustDesk(
          ctx,
          state.messageId,
          `✅ Credential submitted\nConnection: ${response.connectionId}\nStatus: ${response.status ?? "connecting"}`,
        );
        return true;
      }
      return true;
    }

    await deleteInput(ctx);
    const response = await createRustDeskBridgeClientFromEnv().submitCredential({
      credentialRequestId: state.credentialRequestId,
      credential: text,
      trustThisDevice: false,
    });
    await finishToRustDesk(
      ctx,
      state.messageId,
      `✅ Credential submitted\nConnection: ${response.connectionId}\nStatus: ${response.status ?? "connecting"}`,
    );
    return true;
  } catch (error) {
    logger.error("[RustDeskSettings] wizard failed:", error);
    await edit(
      ctx,
      state.messageId,
      `❌ ${error instanceof Error ? error.message : "RustDesk setup failed"}\n\nFix the value and try again, or press Cancel.`,
      cancelKeyboard("integration:rustdesk"),
    ).catch((editError) => {
      logger.error("[RustDeskSettings] failed to render wizard error in General Panel:", editError);
    });
    return true;
  }
}
