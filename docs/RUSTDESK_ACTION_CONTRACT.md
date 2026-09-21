# RustDesk Agent Action Contract

Status: design contract for PR #100. This document is the source of truth for the bot-facing RustDesk action surface before the headless bridge implementation is completed.

## Architecture invariant

Every connection is resolved from three independent questions:

```text
WHO?   -> saved device or RustDesk ID
WHERE? -> RustDesk network/server profile
HOW?   -> authentication/approval mode
            |
            v
       connectionId
            |
            v
 capabilities + permission policy
            |
            v
       remote actions
```

The model must never need to know RustDesk protocol internals, credentials, or GUI details. The bridge resolves saved device metadata, server routing, credentials, authentication state, and protocol primitives.

## Permanent versus temporary access

### Permanent devices

Permanent access is configured only through `Settings -> Integrations -> RustDesk -> Devices`.

A saved device requires:

- user-visible device name
- RustDesk ID
- saved server profile
- permanent password stored in secret storage

The permanent password is mandatory for a saved device. The model-visible device record contains a secret reference/status only; it never contains the password.

Optional 2FA/trusted-controller state may be associated with the bridge identity, but trusted-controller state is not a replacement for the permanent password.

### Temporary connections

Temporary access is initiated from chat. Nothing is promoted into permanent integration storage automatically.

The model may ask the user, using the normal `question` tool, for non-sensitive choices such as:

- RustDesk ID
- public vs saved custom vs one-time custom server
- which saved server profile to use
- manual approval vs temporary password vs password-or-approval

If a password is required, it must be collected by a secure credential-input path that submits directly to the trusted control plane/bridge. Passwords are forbidden in model tool arguments, normal chat-derived action payloads, tool output, audit logs, and error strings.

Temporary RustDesk identifiers, one-time server settings, credential handles, and connection state are deleted when their owning temporary connection expires or disconnects, subject only to non-secret audit metadata.

## Server profiles

Server selection is first-class and is required for both permanent and temporary connections.

### Built-in public profile

```ts
interface RustDeskPublicServerProfile {
  id: "rustdesk-public";
  kind: "public";
  name: "RustDesk Public";
}
```

The public profile is built in and contains no user secret.

### Saved custom/self-hosted profile

```ts
interface RustDeskCustomServerProfile {
  id: string;
  kind: "custom";
  name: string;
  idServer: string;
  relayServer?: string;
  apiServer?: string;
  keyConfigured: boolean;
}
```

The model may see routing metadata needed to identify/select a profile, but any sensitive server credential/key material is represented only by configuration state or an opaque secret reference in the control plane.

### One-time custom server

A temporary connection may use one-time custom routing without saving a server profile. The non-secret routing fields are scoped to that temporary connection and discarded with it. Sensitive key material, if required, uses secure credential input and is never carried in the model action payload.

## Core data models

### Saved device

```ts
interface SavedRustDeskDevice {
  id: string;
  name: string;
  rustdeskId: string;
  serverProfileId: string;
  credentialConfigured: boolean;
  trustedController?: boolean;
  online?: boolean;
  capabilities?: RustDeskCapabilities;
}
```

### Connection

```ts
type RustDeskConnectionKind = "permanent" | "temporary";
type RustDeskConnectionStatus =
  | "connecting"
  | "waiting_remote_approval"
  | "credential_required"
  | "connected"
  | "disconnected"
  | "failed";

interface RustDeskConnection {
  connectionId: string;
  kind: RustDeskConnectionKind;
  status: RustDeskConnectionStatus;
  deviceId?: string;
  rustdeskId: string;
  serverProfileId?: string;
  serverKind: "public" | "saved-custom" | "one-time-custom";
  authMode: RustDeskAuthMode;
  capabilities?: RustDeskCapabilities;
  errorCode?: string;
}
```

### Authentication modes

```ts
type RustDeskAuthMode =
  | "permanent-password"
  | "temporary-password"
  | "manual-approval"
  | "password-or-approval";
```

`permanent-password` is valid only for a saved permanent device. Temporary connections may use `temporary-password`, `manual-approval`, or `password-or-approval`.

### Capabilities

```ts
interface RustDeskCapabilities {
  terminal: boolean;
  screen: boolean;
  mouse: boolean;
  keyboard: boolean;
  touch: boolean;
  clipboard: boolean;
  files: boolean;
  restart: boolean;
}
```

Capabilities are negotiated from the actual RustDesk peer/session state and permissions. They must not be inferred solely from OS family.

## Identifier semantics

Three identifiers must not be conflated:

- `deviceId`: bot-owned ID for a saved permanent integration device.
- `connectionId`: bridge-owned live connection/session handle used by remote actions.
- `terminalId`: RustDesk/PTTY logical terminal handle used only by interactive terminal actions.

`sessionId` is intentionally not used in the new public action contract because it was ambiguous between a RustDesk connection and a PTY terminal session.

## Secret boundary and secure credential handshake

No RustDesk action accepts `password`, `passcode`, `token`, `secret`, raw 2FA code, or raw private server key fields.

When a connection needs a credential, the bridge/control plane returns only an opaque challenge:

```json
{
  "status": "credential_required",
  "credentialRequestId": "credreq_opaque_id",
  "credentialKind": "rustdesk-password"
}
```

The UI obtains the secret through secure input and submits it outside the model action channel. After resolution, the model receives only connection state such as `connected` or a normalized failure code. The opaque request ID must be short-lived, single-purpose, scoped to the intended connection attempt, and non-secret by itself.

Bridge contract v2 makes credential submission retry-safe without retaining the credential: the bridge remembers only the consumed opaque request ID for a bounded TTL. Repeating the same consumed request while no newer challenge exists returns an idempotent success; if the peer has already issued a newer authentication challenge, the old request fails with `credential_request_superseded`. The headless RustDesk adapter consumes its current auth prompt immediately before submitting password/2FA so polling cannot re-emit the same prompt as a fresh challenge.

The normal `question` tool is used only for non-sensitive decisions. The permission system is used for authorization of side effects. Secure input is a third, separate mechanism.

## Permission model

Action execution is determined from:

```text
action metadata/risk
        +
negotiated RustDesk capability/permission
        +
saved-device or temporary-session policy
        +
current user approval/grant
        =
final authorization decision
```

The bridge must always enforce target-side RustDesk/OS permissions. Bot permission grants can restrict access further but can never widen what the remote side permits.

Bridge contract v2 also defines permission-grant retry semantics. Re-submitting the same `permissionGrantId` with the same action, connection and scope is an idempotent success and never extends the original expiry. Reusing that ID for different grant metadata fails closed with `permission_grant_conflict`.

Recommended risk classes:

- `read`: observation only
- `interactive`: remote UI interaction or typing
- `mutating`: filesystem/clipboard/terminal mutation
- `destructive`: restart or similarly disruptive operation

Recommended permission behavior:

- observation/read-only actions may be allowed by policy
- interactive/mutating actions default to `ask` unless the user explicitly grants a broader policy
- destructive actions default to `always-ask`

## Action specification schema

Each action is designed against the following metadata:

```ts
interface RustDeskActionDefinition {
  name: string;
  description: string;
  requiresConnection: boolean;
  requiredCapabilities: (keyof RustDeskCapabilities)[];
  risk: "read" | "interactive" | "mutating" | "destructive";
  permission: "allow" | "ask" | "always-ask";
  credentialAccess: "none" | "bridge-only";
  persistence: "none" | "connection" | "device";
  timeoutMs: number;
  cancellable: boolean;
  idempotent: boolean;
}
```

The exact policy may be overridden by user/device configuration, but the action definition provides the safe baseline.

# Action surface

## `bridge.health`

Purpose: verify bridge availability/version without connecting to a device.

Input: none.

Output: bridge version/build, RustDesk core version/commit if available, health state, supported action protocol version. Never return secrets.

Metadata: no connection; risk `read`; permission `allow`; credential access `none`; persistence `none`; timeout 5s; cancellable yes; idempotent yes.

## Server actions

### `servers.list`

Purpose: list model-selectable server profiles, including built-in RustDesk Public and saved custom/self-hosted profiles.

Input: optional status filter.

Output: profile ID, display name, kind, non-secret routing metadata, and health/configuration summary.

Metadata: no connection; risk `read`; permission `allow`; persistence `device`; timeout 5s; idempotent yes.

### `servers.get`

Purpose: inspect one server profile before choosing it.

Input: `serverProfileId`.

Output: non-secret profile metadata and configuration/health summary.

Metadata: no connection; risk `read`; permission `allow`; persistence `device`; timeout 5s; idempotent yes.

### `servers.test`

Purpose: test reachability/configuration of an existing saved profile or non-secret one-time routing configuration. This does not authenticate to a target device.

Input: either `serverProfileId`, or one-time non-secret routing fields. Sensitive server key material, if required, is resolved by the secure control plane rather than supplied by the model.

Output: normalized reachability/latency/configuration result; no secrets.

Metadata: no device connection; risk `read`; permission `allow`; persistence `none`; timeout 15s; cancellable yes; idempotent yes.

Permanent server profile creation/editing/deletion is intentionally not model-facing in this phase. It belongs to Settings/Integrations.

## Permanent device actions

### `devices.list`

Purpose: list saved permanent RustDesk integrations.

Input: optional status filter.

Output: `SavedRustDeskDevice[]` without credentials.

Metadata: no connection; risk `read`; permission `allow`; persistence `device`; timeout 5s; idempotent yes.

### `devices.get`

Purpose: inspect one saved device and its associated server/auth/capability status.

Input: `deviceId`.

Output: saved device metadata without credentials.

Metadata: no connection; risk `read`; permission `allow`; persistence `device`; timeout 5s; idempotent yes.

### `devices.connect`

Purpose: connect to a saved permanent device using its saved server profile and bridge-only permanent credential.

Input: `deviceId` only, plus optional bounded connection timeout. The model cannot override the saved password or inject a raw credential.

Output: `RustDeskConnection`. On credential/2FA handling that cannot be completed automatically, return a normalized challenge/status without disclosing secret material.

Requires target consent/permissions as configured in RustDesk. This action never bypasses target-side controls.

Metadata: no pre-existing connection; risk `interactive`; permission `ask`; credential access `bridge-only`; persistence `connection`; timeout default 30s / cap 120s; cancellable yes; idempotent no.

Permanent device creation/editing/removal is intentionally handled in Settings/Integrations, not by model actions.

## Temporary connection actions

### `session.connectTemporary`

Purpose: create an ephemeral connection from chat.

Required input:

- `rustdeskId`
- `server`: exactly one of:
  - `{ kind: "public" }`
  - `{ kind: "saved-custom", serverProfileId: string }`
  - `{ kind: "one-time-custom", idServer: string, relayServer?: string, apiServer?: string }`
- `authMode`: `temporary-password`, `manual-approval`, or `password-or-approval`

Forbidden input: raw passwords, passcodes, tokens, secret keys, 2FA secrets.

Output: `RustDeskConnection`, possibly first entering `waiting_remote_approval` or `credential_required`.

No permanent device or server profile is created.

Metadata: no pre-existing connection; risk `interactive`; permission `ask`; credential access `bridge-only` when required; persistence `connection`; timeout default 30s / cap 120s; cancellable yes; idempotent no.

### `connection.status`

Purpose: inspect live connection state, peer metadata, negotiated capabilities and target permissions.

Input: `connectionId`.

Output: normalized `RustDeskConnection` plus safe peer metadata.

Metadata: requires connection handle; risk `read`; permission `allow`; credential access `none`; persistence `none`; timeout 5s; cancellable yes; idempotent yes.

### `connection.disconnect`

Purpose: close a live permanent or temporary connection and release connection-scoped resources.

Input: `connectionId`.

Output: final disconnected state and cleanup summary.

For temporary connections this also destroys temporary routing/credential handles owned by the connection.

Metadata: requires connection; risk `interactive`; permission `allow`; credential access `none`; persistence `none`; timeout 10s; cancellable yes; idempotent yes.

## Terminal actions

Terminal actions require negotiated `terminal` capability and an authorized connection.

### `terminal.open`

Input: `connectionId`, optional bounded `rows`/`cols`.

Output: `terminalId`, effective rows/cols, shell/platform metadata if available.

Risk `mutating`; permission `ask`; timeout 15s; cancellable yes; idempotent no.

### `terminal.write`

Input: `connectionId`, `terminalId`, bounded text/data.

Output: bytes/chars accepted.

Risk `mutating`; permission follows the terminal grant established for the interactive terminal unless policy requires per-write confirmation; timeout 10s; cancellable yes; idempotent no.

### `terminal.read`

Input: `connectionId`, `terminalId`, optional bounded wait/max-bytes.

Output: bounded terminal data and stream state.

Risk `read`; permission `allow` once terminal access is authorized; timeout bounded by requested wait; cancellable yes; idempotent no because reads may advance bridge-side queue state.

### `terminal.resize`

Input: `connectionId`, `terminalId`, `rows`, `cols`.

Output: effective size.

Risk `interactive`; permission follows terminal grant; timeout 10s; cancellable yes; idempotent yes.

### `terminal.close`

Input: `connectionId`, `terminalId`.

Output: closed state.

Risk `interactive`; permission `allow`; timeout 10s; cancellable yes; idempotent yes.

### `terminal.exec`

Purpose: high-level one-shot command convenience implemented by the bridge over a temporary RustDesk PTY.

Input: `connectionId`, command, bounded timeout/output limits, optional working-directory hint where supported. It does not accept credentials.

Output: bounded command output, normalized exit code when reliably parsed, timeout/truncation flags.

Implementation invariant: use shell-specific unique completion framing/sentinel; never infer completion from a shell prompt. The bridge owns open/write/read/parse/close cleanup.

Risk `mutating`; permission `ask`; timeout caller-bounded / hard cap 120s initially; cancellable yes; idempotent no.

## Screen action

### `screen.capture`

Input: `connectionId`, optional display index and image format/quality bounds.

Output: image artifact/binary metadata; the bot persists large binary data outside model-visible JSON.

Requires `screen`; risk `read`; permission `allow` by default subject to device/session policy; timeout 15s; cancellable yes; idempotent yes.

## Mouse actions

All require `connectionId` + `mouse` capability and valid display/coordinate bounds.

- `mouse.move`: move pointer. Risk `interactive`; permission `ask`/active interaction grant; idempotent yes.
- `mouse.click`: click button once. Risk `interactive`; idempotent no.
- `mouse.doubleClick`: double click. Risk `interactive`; idempotent no.
- `mouse.drag`: bounded drag from/to coordinates. Risk `interactive`; cancellable where protocol allows; idempotent no.
- `mouse.scroll`: bounded horizontal/vertical scroll. Risk `interactive`; idempotent no.

These actions map to RustDesk input primitives; the model does not construct protocol messages.

## Keyboard actions

Require `connectionId` + `keyboard` capability.

### `keyboard.type`

Input: bounded text.

Risk `interactive`; permission `ask`/active interaction grant; idempotent no.

### `keyboard.press`

Input: normalized key plus optional modifier list/repeat count bounds.

Risk `interactive`; permission `ask`/active interaction grant; idempotent no.

The bridge maps normalized keys to the correct RustDesk/platform representation.

## Touch actions

Require `connectionId` + `touch` capability.

- `touch.tap`: point.
- `touch.longPress`: point + bounded duration.
- `touch.swipe`: start/end + bounded duration.

Risk `interactive`; permission `ask`/active interaction grant; idempotent no. The bridge maps these high-level gestures to RustDesk pointer/touch protocol semantics and respects target-side Accessibility/OS permission state.

## Clipboard actions

Initial scope is text clipboard only.

### `clipboard.read`

Input: `connectionId`.

Output: bounded text plus truncation metadata.

Requires `clipboard`; risk `read`; permission subject to clipboard policy; timeout 10s; idempotent yes.

### `clipboard.write`

Input: `connectionId`, bounded text.

Output: accepted/updated state.

Requires `clipboard`; risk `mutating`; permission `ask`; timeout 10s; idempotent yes for the same value.

The headless bridge uses RustDesk clipboard protocol events and does not depend on a GUI clipboard on the bridge host.

## File actions

Require `connectionId` + `files` capability. Existing local worktree path containment and transfer-size limits remain authoritative on the bot side.

### `files.list`

Input: remote path and bounded pagination/list options.

Output: normalized directory entries.

Risk `read`; permission according to file-read policy; timeout 30s; cancellable yes; idempotent yes.

### `files.read`

Input: remote path and bounded maximum bytes.

Output: bounded text/binary artifact metadata. Implemented through a bounded temporary RustDesk download if no direct read primitive exists.

Risk `read`; permission according to file-read policy; timeout 60s; cancellable yes; idempotent yes.

### `files.upload`

Input: `connectionId`, approved bot-local source artifact/path and remote destination path. No arbitrary bridge-host filesystem escape.

Output: transfer summary.

Risk `mutating`; permission `ask`; timeout up to 120s initially; cancellable yes; idempotent no.

### `files.download`

Input: `connectionId`, remote source path and bounded bot-local destination/artifact request.

Output: transfer/artifact metadata. Base64 payloads are not exposed to the model.

Risk `read`; permission according to file-read policy; timeout up to 120s initially; cancellable yes; idempotent yes for the same source snapshot.

## System actions

### `system.info`

Input: `connectionId`.

Output: safe peer/system metadata and capability state.

Risk `read`; permission `allow`; timeout 10s; idempotent yes.

### `system.restart`

Input: `connectionId` and optional non-sensitive confirmation context.

Output: accepted/disconnecting/restarting state.

Requires `restart`; risk `destructive`; permission `always-ask`; timeout 15s for request acknowledgement; idempotent no.

This must use RustDesk's normal authorized restart path and must never bypass remote OS/RustDesk controls.

## Validation invariants

The bot and bridge both enforce these rules independently:

1. Reject unknown action names.
2. Reject raw secret-like fields such as `password`, `passcode`, `token`, `secret`, `privateKey`, or `twoFactorCode` in model-originated RustDesk action args.
3. `devices.connect` requires `deviceId` and does not accept server/auth overrides.
4. `session.connectTemporary` requires a RustDesk ID, explicit server selection, and a temporary auth mode.
5. Operational actions require `connectionId`.
6. Interactive terminal actions require both `connectionId` and `terminalId` where applicable.
7. Capability checks happen before protocol execution.
8. Permission checks happen before side effects.
9. Target-side RustDesk/OS denial always wins.
10. Outputs and logs are scrubbed of credentials and sensitive tokens.
11. Binary output is persisted as an artifact where appropriate rather than dumped into model-visible JSON.
12. Temporary connection cleanup removes connection-owned credentials and one-time routing state.

## First end-to-end milestone

The first implementation milestone uses a saved permanent device or an explicitly created temporary connection and then the same common terminal path:

```text
WHO + WHERE + HOW
        |
        v
    connectionId
        |
        v
terminal.open -> terminalId
        |
terminal.write
        |
terminal.read
        |
terminal.close
        |
connection.disconnect
```

After this works over real RustDesk transport, `terminal.exec` and the remaining capability families can be layered on without changing connection semantics.