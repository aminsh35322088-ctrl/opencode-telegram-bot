# RustDesk Lab backup — 2026-09-17

This branch is an emergency persistence snapshot of RustDesk controller work that was still local on the temporary GitHub Lab runner before its lifecycle reset.

## Source anchors

- Bot PR head at backup start: `1e585a63ba7524ccfd74bcadf739e62686cff6fd`
- RustDesk upstream snapshot: `0b3a1ddd80285c87baad495f79b54d19ef3ba4d9`
- RustDesk package observed: `1.5.0`

## Preserved artifacts

- `rustdesk/headless_controller.rs` — latest headless `Session<HeadlessHandler>` controller prototype recovered from Lab command history.
- `rustdesk/lib.rs.patch` — module export needed in upstream RustDesk.
- `bridge/Cargo.toml` — separate AGPL controller bridge package manifest.
- `bridge/src/main.rs` — first JSON/HTTP bridge milestone with saved-device connect + terminal open/write/read/resize/close.
- `rustdesk-build-env.Dockerfile` — reproducible Linux build environment used to get upstream RustDesk `cargo check` past GLib/native dependency blockers.

## Verified before backup

The upstream RustDesk library check succeeded with `cargo check --lib --no-default-features --features linux-pkg-config` after supplying the Linux native dependencies and a `libyuv.pc` shim. The bridge package itself had not yet reached a clean compile verdict; its first isolated check hit dependency-resolution/build-environment issues and was still being iterated.

No production RustDesk passwords, tokens, or server keys are stored in this backup. The prototype references secrets by environment-variable name only.
