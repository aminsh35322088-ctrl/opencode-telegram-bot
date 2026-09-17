# RustDesk Headless Controller Bridge — Source-Grounded Design

Status: research/implementation branch. This document records the source-grounded RustDesk integration seam and implementation plan. The exact model-facing contract is defined in [`RUSTDESK_ACTION_CONTRACT.md`](./RUSTDESK_ACTION_CONTRACT.md).

The RustDesk source research in this branch was performed against `master` at `0b3a1ddd80285c87baad495f79b54d19ef3ba4d9` (package version 1.5.0 at the time of inspection).

## Decision

The bridge is a separate AGPL Rust component based on RustDesk core, not a wrapper around the stock RustDesk CLI.

The bot remains a separate process and talks to the bridge through a JSON action contract (`POST /v1/action`). RustDesk credentials stay outside model-visible action payloads.

```text
Telegram / OpenCode agent
          |
          | model-facing actions
          v
Bot RustDesk action adapter
          |
          | JSON /v1/action
          v
RustDesk headless bridge (AGPL)
          |
          | Session<HeadlessHandler> / RustDesk protocol
          v
Authorized remote device
```

## Connection architecture: WHO + WHERE + HOW

Every connection resolves three independent concerns before remote actions are available:

```text
WHO?   -> saved device or RustDesk ID
WHERE? -> RustDesk Public / saved custom profile / one-time custom routing
HOW?   -> permanent password / temporary password / manual approval / password-or-approval
            |
            v
       connectionId
            |
            v
 negotiated capabilities + target permissions
            |
            v
       agent permission policy
            |
            v
       remote actions
```

Connection-server selection is first-class. The bridge must never assume that a RustDesk ID belongs to the public RustDesk network. A private/self-hosted ID or relay server may be required for both permanent devices and temporary chat sessions.

## Permanent access

Permanent devices are enrolled only through `Settings -> Integrations -> RustDesk -> Devices`.

A permanent device stores:

- a user-visible name
- RustDesk ID
- a saved server profile
- a permanent password in secret storage
- optional trusted-controller/2FA state
- discovered peer/capability metadata

Permanent password configuration is mandatory for a saved device. The model receives only non-secret device/authentication status and never the password itself.

Server profiles live separately under `Settings -> Integrations -> RustDesk -> Server Profiles`, so multiple devices can share one public or self-hosted network configuration and routing can be updated in one place.

## Temporary access

Temporary access starts in chat and is never promoted to a saved device automatically.

The normal `question` tool may collect non-sensitive choices such as:

- RustDesk ID
- public versus saved custom versus one-time custom server
- which saved server profile to use
- manual approval versus temporary password versus password-or-approval

When a password or other secret is needed, the connection enters `credential_required` and returns only an opaque `credentialRequestId`. A secure credential-input path submits the secret directly to the trusted control plane/bridge. The secret is not a normal model tool argument and must not appear in tool output or audit logs.

One-time routing, temporary credential handles, and temporary connection state are destroyed on disconnect/expiry except for non-secret audit metadata.

## Question, permission, and credential boundaries

These are separate mechanisms and must not be conflated:

```text
question
  -> non-sensitive user decision/preferences

permission
  -> authorization for a side-effecting remote action

secure credential input
  -> secret submission outside model context

RustDesk action
  -> actual bridge operation
```

The target-side RustDesk/OS permission state is authoritative. Bot policy can restrict actions further but can never widen what the remote side permits.

## Stable identifiers

The public action contract uses three distinct identifiers:

- `deviceId`: bot-owned saved integration device
- `connectionId`: live RustDesk bridge connection
- `terminalId`: interactive remote PTY

The old ambiguous `sessionId` is intentionally removed from the public RustDesk action contract.

## Why not the stock CLI

RustDesk recognizes `--connect`, `--file-transfer`, `--view-camera`, `--port-forward`, `--terminal`, and `--rdp`, but those flags route into connection/UI startup. They are not a stable machine-oriented JSON or command-exec API.

The target is therefore a dedicated headless binary built from the required RustDesk core pieces, with desktop UI/windowing dependencies excluded from the bridge build path.

## Verified controller seam

RustDesk already has a generic controller abstraction:

```rust
pub struct Session<T: InvokeUiSession> { ... }
pub trait InvokeUiSession: Send + Sync + Clone + 'static + Sized + Default { ... }

#[tokio::main(flavor = "current_thread")]
pub async fn io_loop<T: InvokeUiSession>(handler: Session<T>, round: u32) { ... }
```

The existing Flutter client is one implementation of that abstraction. A bridge-specific `HeadlessHandler` can implement the same callback trait and send events into channels/state instead of a GUI.

The inspected RustDesk crate keeps `client` and `ui_session_interface` private, so the clean implementation is a small RustDesk fork/patch that exports or contains the headless controller module. RustDesk-derived implementation code must not be copied into the bot's MIT codebase.

A prototype patch is recorded in `docs/patches/rustdesk-headless-controller-prototype.patch`. It is a prototype only; it has not yet passed a complete Rust build because the first check reached an unrelated desktop/native `glib-2.0` dependency before a meaningful compile verdict on the prototype.

## Headless build isolation

The next Rust-side requirement is to make the controller build independent of unnecessary GUI dependencies.

The desired output is conceptually:

```text
RustDesk source/core
├── rendezvous / relay / networking       yes
├── authentication / protocol             yes
├── terminal / file transfer              yes
├── video decode / input protocol         yes
├── headless_controller                    yes
├── Flutter / Sciter UI                    no
├── desktop window/tray                    no
└── rustdesk-agent-bridge binary           yes
```

The build work should inspect the actual dependency graph (including why `glib-sys` is pulled), then isolate the bridge behind a dedicated package/bin/feature rather than merely installing every desktop dependency on the build host.

## Headless handler responsibilities

`HeadlessHandler: InvokeUiSession` retains machine-oriented state only:

- connection status and normalized errors
- `PeerInfo`, server/network identity, and permission/capability state
- latest decoded RGBA frame per display
- terminal response queues keyed by terminal ID
- file-transfer directory/job/progress/error events
- screenshot responses
- clipboard text state/events
- optional cursor/display metadata

It should not depend on Flutter widgets, windowing, or UI rendering.

## Bridge state managers

The bridge should have explicit ownership boundaries:

```text
ServerProfileManager
  -> public/saved custom routing resolution

DeviceRegistry
  -> saved permanent device metadata + secret references

ConnectionManager
  -> live permanent and temporary connectionId lifecycle

CredentialCoordinator
  -> opaque credential challenges and bridge-only secret access

CapabilityMapper
  -> negotiated RustDesk feature/permission state

Permission/Audit boundary
  -> action authorization inputs + non-secret audit records
```

The bot can own user-facing integration records while the bridge receives only the resolved information required to create an authorized connection. Secrets remain opaque to the model.

## Action mapping

The complete action list and exact input/output/security rules live in `RUSTDESK_ACTION_CONTRACT.md`. The bridge families are:

```text
bridge.*
servers.*
devices.*
session.*
connection.*
terminal.*
screen.*
mouse.*
keyboard.*
touch.*
clipboard.*
files.*
system.*
```

Permanent device/server creation and editing remain Settings/Integrations operations, not general model actions.

### Connection lifecycle

`devices.connect(deviceId)` resolves the saved server profile and permanent bridge-only credential, then creates a `connectionId`.

`session.connectTemporary(...)` receives an explicit RustDesk ID, explicit server selection, and a temporary authentication mode. It may enter `waiting_remote_approval` or `credential_required` before becoming connected.

`connection.status(connectionId)` exposes safe peer/capability/permission state. `connection.disconnect(connectionId)` closes the RustDesk connection and destroys temporary connection-owned secret/routing state.

### Terminal

RustDesk protocol currently defines PTY-style terminal operations:

```text
OpenTerminal
TerminalData
ResizeTerminal
CloseTerminal
```

Responses are:

```text
TerminalOpened
TerminalData
TerminalClosed
TerminalError
```

There is no direct protocol-level `exec(command) -> exitCode` message. Therefore:

- `terminal.open/write/read/resize/close` map to RustDesk terminal actions.
- `terminal.exec` is a bridge convenience built on a temporary PTY.
- The bridge opens a PTY, sends shell-specific framed input, waits for a unique completion sentinel, strips framing, parses a bounded result/exit code, and always closes the PTY.
- Completion must never be inferred from a shell prompt.

### Screen

The generic UI callback already receives decoded frames:

```rust
fn on_rgba(&self, display: usize, rgba: &mut scrap::ImageRgb)
```

`HeadlessHandler` keeps the latest bounded frame per display. `screen.capture` encodes that frame as PNG/JPEG (or another explicitly supported format) and returns binary/artifact data through the bridge contract rather than screen-scraping a RustDesk window.

### Mouse and keyboard

RustDesk core already exposes mouse and keyboard event senders. The bridge translates model-friendly actions (`mouse.click`, `mouse.drag`, `keyboard.type`, `keyboard.press`) into those existing events.

### Touch

RustDesk protocol has pointer/touch messages and Android's controlled-side Accessibility service maps the authorized input events to native gestures. The bridge exposes model-level `tap`, `longPress`, and `swipe` and preserves RustDesk's actual coordinate/event semantics.

### Files

RustDesk protocol has `FileAction` / `FileResponse`, including remote directory listing and send/receive transfer jobs.

- `files.list` maps to remote directory listing.
- `files.upload` and `files.download` use transfer jobs.
- `files.read` is a bounded temporary download/read when no direct bounded read primitive exists.
- Bot worktree containment and transfer-size limits remain authoritative for bot-local paths.

### Clipboard

Clipboard requires a headless protocol adapter instead of dependence on the controller host's GUI clipboard. Initial scope is text only. Rich/file clipboard can be added later.

### Restart

`system.restart` maps to RustDesk's normal authorized remote restart primitive and remains destructive/approval-gated.

## Capability discovery

Capabilities are negotiated from RustDesk peer info, connection type, permission state, and protocol feature flags rather than hard-coded from OS name alone.

Example:

```json
{
  "connectionId": "conn_123",
  "os": { "family": "linux", "name": "Ubuntu" },
  "capabilities": {
    "terminal": true,
    "screen": false,
    "mouse": false,
    "keyboard": false,
    "touch": false,
    "clipboard": true,
    "files": true,
    "restart": true
  }
}
```

The model receives safe metadata and chooses an appropriate action. The bridge enforces what the negotiated connection actually permits.

## Authentication and consent boundary

- Permanent enrollment is explicit through Settings/Integrations.
- Temporary access is explicit and scoped to a chat-created connection.
- Saved permanent passwords are bridge/control-plane secrets.
- Temporary secrets use opaque credential requests and secure input.
- Never expose RustDesk passwords, tokens, private server keys, or 2FA secrets in model-visible output/logs.
- Respect RustDesk and OS permission prompts; do not bypass host consent/security controls.
- Audit mutating/destructive operations with non-secret device/connection/action/timestamp/result metadata.

## Licensing boundary

The inspected upstream RustDesk repository is AGPL-3.0. The RustDesk-derived headless controller/fork should therefore remain a separate AGPL component. The bot communicates with it through the JSON bridge boundary. Exact distribution/hosting obligations should be reviewed before release.

## Implementation phases

1. **Action and architecture specification — complete for current design**
   - exact action surface and validation invariants
   - WHO / WHERE / HOW connection model
   - permanent vs temporary lifecycle
   - server profiles
   - question / permission / secure-input separation

2. **Settings / Integration storage**
   - `RustDesk -> Devices`
   - `RustDesk -> Server Profiles`
   - saved-device references to server profiles
   - secret references/configured state without model-visible values

3. **Headless RustDesk core build isolation**
   - isolate/export `headless_controller`
   - remove unnecessary UI dependencies from the bridge build path
   - compile `HeadlessHandler`
   - connection/peer/capability state
   - terminal open/write/read/resize/close

4. **Bridge server and connection manager**
   - health endpoint / `bridge.health`
   - `POST /v1/action`
   - session/connection lifecycle
   - request limits and normalized errors
   - bridge authentication and non-secret audit records

5. **Connection/authentication coordinator**
   - saved permanent `devices.connect`
   - temporary `session.connectTemporary`
   - public/saved-custom/one-time-custom routing
   - manual approval state
   - opaque secure-credential challenges

6. **Terminal end-to-end**
   - connection -> PTY open/write/read/resize/close
   - `terminal.exec` framing, output limits, timeout, exit-code parsing

7. **Screen and input**
   - latest RGBA frame store + image encoding
   - mouse/keyboard
   - Android touch gesture mapping

8. **Files, clipboard, and system**
   - list/upload/download/bounded read
   - headless text clipboard adapter
   - system info/restart

9. **Permission and capability enforcement**
   - per-action risk metadata
   - negotiated capability/permission checks
   - saved-device/temporary-connection policy
   - approval integration

10. **Integration and end-to-end tests**
   - mock/headless protocol tests
   - public and custom/self-hosted server routing
   - Linux/headless target
   - desktop target
   - Android target where Accessibility input control is enabled

## First implementation milestone

The first useful transport milestone now starts after explicit connection resolution:

```text
saved device OR temporary WHO + WHERE + HOW
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

Once this works over real RustDesk transport, `terminal.exec` and the remaining capability families can be layered on without changing the connection semantics.