# RustDesk Headless Controller Bridge — Source-Grounded Design

Status: research/implementation branch. This document records the integration seam verified against RustDesk `master` at `0b3a1ddd80285c87baad495f79b54d19ef3ba4d9` (package version 1.5.0).

## Decision

The bridge should be a separate AGPL Rust component based on RustDesk core, not a wrapper around the stock RustDesk CLI.

The bot remains a separate process and talks to the bridge through the existing JSON action contract (`POST /v1/action`). RustDesk credentials stay inside the bridge.

```text
OpenCode agent (bot)
        |
        | JSON /v1/action
        v
RustDesk headless bridge (AGPL)
        |
        | Session<HeadlessHandler> / RustDesk protocol
        v
Authorized remote device
```

## Why not the stock CLI

RustDesk recognizes `--connect`, `--file-transfer`, `--view-camera`, `--port-forward`, `--terminal`, and `--rdp`, but those flags route into connection/UI startup. They are not a stable machine-oriented JSON or command-exec API.

## Verified controller seam

RustDesk already has a generic controller abstraction:

```rust
pub struct Session<T: InvokeUiSession> { ... }
pub trait InvokeUiSession: Send + Sync + Clone + 'static + Sized + Default { ... }

#[tokio::main(flavor = "current_thread")]
pub async fn io_loop<T: InvokeUiSession>(handler: Session<T>, round: u32) { ... }
```

The existing Flutter client is one implementation of that abstraction. A bridge-specific `HeadlessHandler` can implement the same callback trait and send events into channels/state instead of a GUI.

The current RustDesk crate keeps `client` and `ui_session_interface` private, so the clean implementation is a tiny RustDesk fork/patch that exports or contains the headless controller module. Do not copy RustDesk implementation code into the bot repository.

## Existing public Flutter API confirms feature coverage

Current `flutter_ffi` already exposes controller operations for:

- session create/start/close/reconnect/login/2FA
- mouse, keyboard text/key input, touch/pointer input
- screenshot requests
- remote restart
- terminal open/input/resize/close
- remote-directory listing and file-transfer jobs

This is strong evidence that the generic core has the primitives required by the bot action pack.

## Headless handler responsibilities

`HeadlessHandler: InvokeUiSession` should retain only machine-oriented state:

- connection status and errors
- `PeerInfo` and permission/capability state
- latest decoded RGBA frame per display
- terminal response queues keyed by terminal ID
- file-transfer directory/job/progress/error events
- screenshot responses
- clipboard state/events
- optional cursor/display metadata

It should not depend on Flutter widgets, windowing, or user-interface rendering.

## Action mapping

### Device/session lifecycle

`device.connect` creates a RustDesk session for a previously enrolled device, starts the generic I/O loop, waits for peer info/connection state, and returns negotiated metadata.

`device.disconnect` closes/removes the session.

`devices.list` is bridge-owned enrollment/session metadata plus current online/capability state. Passwords and connection tokens are never returned.

### Terminal

RustDesk protocol currently defines only PTY-style terminal operations:

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

- `terminal.open/write/read/close` map directly to RustDesk terminal actions.
- `terminal.exec` is a bridge convenience built on a temporary PTY.
- The bridge opens a PTY, sends a shell-specific framed command, waits for a unique completion sentinel, strips framing, returns bounded stdout/stderr-like text plus parsed exit code, then closes the PTY.
- Never infer completion from a shell prompt.
- Use platform-specific command framing for POSIX shells versus PowerShell/cmd.

The server launches the platform default shell and supports persistent terminal services/reconnect buffers, so interactive sessions can survive a controller reconnect when RustDesk permits it.

### Screen

The generic UI callback already receives decoded frames:

```rust
fn on_rgba(&self, display: usize, rgba: &mut scrap::ImageRgb)
```

`HeadlessHandler` should keep the latest bounded frame for each display. `screen.capture` encodes the latest frame to PNG/JPEG and returns it to the bot-side bridge client as bounded binary/base64 according to the existing contract.

This is preferable to screen-scraping a RustDesk window.

### Mouse and keyboard

RustDesk core already exposes mouse and keyboard event senders. The bridge translates model-friendly actions (`mouse.click`, `mouse.drag`, `keyboard.type`, `keyboard.press`) into those existing events.

### Touch

RustDesk protocol has `PointerDeviceEvent -> TouchEvent` with pan start/update/end and scale updates. Android's controlled-side accessibility service maps those events to native gestures.

Bridge mapping:

- `touch.tap(x,y)`: pan-start followed by pan-end at the point.
- `touch.longPress(x,y,duration)`: pan-start, hold for bounded duration, pan-end.
- `touch.swipe(from,to,duration)`: pan-start, timed pan-update deltas, pan-end.

The bridge must preserve RustDesk's coordinate/delta semantics rather than synthesizing Android Accessibility calls itself.

### Files

RustDesk protocol already has `FileAction` / `FileResponse`, including remote directory listing and send/receive transfer jobs. The headless handler receives directory entries, progress, errors, and completion callbacks.

- `files.list` maps to remote `ReadDir`.
- `files.upload` and `files.download` use RustDesk transfer jobs.
- `files.read` is implemented as a bounded temporary download followed by local read, not an unbounded special protocol.
- Existing bot/bridge transfer-size limits remain authoritative.

### Restart

`system.restart` maps to RustDesk's existing remote restart action.

## Clipboard

Clipboard needs an adapter rather than a blind mapping to local GUI clipboard state.

RustDesk protocol carries `Clipboard` / `MultiClipboards`, and the client I/O loop applies permission/view-only checks before handling incoming clipboard messages. The bridge should capture/send text clipboard protocol events in controller state without requiring an OS desktop clipboard on the bridge host.

Initial bridge scope should support text clipboard only. Rich/file clipboard can be added later.

## Capability discovery

Capabilities are negotiated from RustDesk peer info, platform, connection type, permission state, and protocol feature flags rather than hard-coded from OS name alone.

Example:

```json
{
  "id": "server-1",
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

The model receives metadata and chooses the action. The bridge enforces what the negotiated session actually permits.

## Authentication and consent boundary

- Device enrollment is explicit and bridge-owned.
- Store a unique credential/token per authorized device.
- Never expose RustDesk passwords, connection tokens, or 2FA secrets to model tool output.
- Respect RustDesk and OS permission prompts; do not bypass host consent/security controls.
- Log sensitive/mutating actions with device ID, action, timestamp, and result.

## Licensing boundary

Current upstream RustDesk is AGPL-3.0. The headless controller/fork should therefore live as a separate AGPL component. The bot communicates with it only through the JSON bridge contract. Exact distribution/hosting obligations should be reviewed before release.

## Implementation phases

1. **Headless core prototype**
   - add/export a RustDesk `headless_controller` module
   - implement `HeadlessHandler`
   - connect/disconnect and peer-info state
   - terminal open/write/read/close

2. **Bridge server**
   - `GET /health` or `bridge.health`
   - `POST /v1/action`
   - authentication, request limits, per-device authorization, action audit log

3. **Terminal exec**
   - shell-specific sentinel framing
   - bounded output/timeouts
   - exit-code parsing

4. **Screen/input**
   - latest RGBA frame store + image encoding
   - mouse/keyboard
   - Android touch gesture mapping

5. **Files/clipboard/system**
   - list/upload/download/bounded read
   - text clipboard adapter
   - system info/restart

6. **Integration tests**
   - mock/headless protocol tests
   - one Linux server target
   - one desktop target
   - Android target where Accessibility input control is enabled

## First implementation milestone

The first useful end-to-end milestone is deliberately small:

```text
devices.list
  -> device.connect
  -> terminal.open
  -> terminal.write("uname -a\n")
  -> terminal.read
  -> terminal.close
```

Once that works through the RustDesk transport, `terminal.exec` and the rest of the action pack can be layered on without changing the bot-facing API.
