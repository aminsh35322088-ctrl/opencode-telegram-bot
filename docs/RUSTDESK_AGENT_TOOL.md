# RustDesk Agent Tool

This integration gives OpenCode a structured remote-computer action surface while keeping RustDesk itself behind a small bridge process.

The bot repository does **not** vendor or link RustDesk source. RustDesk is AGPL-licensed and has its own protocol/runtime concerns, so the bridge is intentionally a separate process. The OpenCode tool talks to that bridge over a narrow JSON API.

## Design goals

- Let the model discover remote devices and their real capabilities before acting.
- Expose terminal, screen, pointer, keyboard, touch, clipboard, file, and system operations as explicit agent actions.
- Avoid hard-coded OS routing. A model can see `os` + `capabilities` from `devices.list` and choose the best action itself.
- Prefer terminal operations for tasks that are naturally shellable, while retaining GUI control for Windows/macOS/desktop Linux and touch control for Android.
- Keep RustDesk passwords and long-lived device credentials out of prompts and tool arguments.
- Keep the bridge transport replaceable so the model-facing action API does not depend on RustDesk internals.

## Agent workflow

A normal run starts with:

```text
rustdesk(action="devices.list")
```

The bridge should return metadata similar to:

```json
{
  "ok": true,
  "devices": [
    {
      "id": "ubuntu-01",
      "name": "Build server",
      "online": true,
      "os": {
        "family": "linux",
        "name": "Ubuntu",
        "version": "24.04",
        "arch": "x86_64"
      },
      "capabilities": {
        "terminal": true,
        "files": true,
        "screen": false,
        "mouse": false,
        "keyboard": false,
        "touch": false,
        "clipboard": false
      }
    }
  ]
}
```

The model can then naturally choose `terminal.exec` for that device. A Windows desktop with `screen`, `mouse`, and `keyboard` capabilities can instead be controlled through GUI actions when CLI access is not the best path.

## Action surface

### Discovery and lifecycle

- `bridge.health`
- `devices.list`
- `device.info`
- `device.connect`
- `device.disconnect`

### Terminal

- `terminal.exec` — run a command and return stdout/stderr/exit code
- `terminal.open` — create an interactive/persistent terminal session
- `terminal.write` — send input to a terminal session
- `terminal.read` — read buffered terminal output
- `terminal.close` — close a terminal session

### Screen and input

- `screen.capture`
- `mouse.move`
- `mouse.click`
- `mouse.doubleClick`
- `mouse.drag`
- `mouse.scroll`
- `keyboard.type`
- `keyboard.press`
- `touch.tap`
- `touch.longPress`
- `touch.swipe`

### Clipboard and files

- `clipboard.read`
- `clipboard.write`
- `files.list`
- `files.read`
- `files.upload`
- `files.download`

### System

- `system.info`
- `system.restart`

## Bridge API contract

The OpenCode tool sends every action to:

```text
POST /v1/action
Content-Type: application/json
Authorization: Bearer <RUSTDESK_BRIDGE_TOKEN>  # required for non-loopback bridges
```

Example request:

```json
{
  "action": "terminal.exec",
  "deviceId": "ubuntu-01",
  "command": "uname -a"
}
```

Example response:

```json
{
  "ok": true,
  "stdout": "Linux ubuntu-01 ...",
  "stderr": "",
  "exitCode": 0
}
```

The bridge is responsible for mapping these actions onto RustDesk client/core capabilities, maintaining authenticated RustDesk sessions, enforcing per-device permissions, and returning stable JSON results.

## Binary results

`screen.capture` may return:

```json
{
  "ok": true,
  "mimeType": "image/png",
  "width": 1920,
  "height": 1080,
  "imageBase64": "..."
}
```

The OpenCode tool writes the image into the active worktree and returns the local path instead of dumping the base64 payload into the model context.

`files.download` follows the same pattern with `contentBase64`. `files.upload` reads a worktree-local file, encodes it, and forwards it to the bridge.

## Configuration

```env
RUSTDESK_BRIDGE_URL=http://127.0.0.1:21119
RUSTDESK_BRIDGE_TOKEN=
RUSTDESK_BRIDGE_TIMEOUT_MS=30000
RUSTDESK_MAX_TRANSFER_BYTES=8388608
```

A remote bridge URL requires `RUSTDESK_BRIDGE_TOKEN`. Loopback is allowed without a token for local sidecar development.

## Security model

The model receives device IDs and capability metadata, not raw RustDesk passwords. The bridge should own unattended-access credentials and enforce authorization per device/action. Sensitive operations should be auditable by the bridge.

Local file upload/download paths are constrained to the current OpenCode worktree. Transfer size is bounded by `RUSTDESK_MAX_TRANSFER_BYTES` (8 MiB by default, 64 MiB hard maximum in the tool).

## Current implementation boundary

This repository now contains the **agent-facing action pack and bridge client contract**. The separate RustDesk bridge process that translates these actions into RustDesk protocol/core calls is the next implementation layer. Keeping that boundary explicit avoids pretending the stock RustDesk CLI exposes a stable machine-oriented API for every GUI primitive when it does not.
