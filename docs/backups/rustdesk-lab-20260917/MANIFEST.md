# RustDesk Lab emergency backup

Created from the live GitHub Lab work before runner reset risk and refreshed after the replacement runner restored the prototype.

## RustDesk upstream baseline

- Upstream repository: `rustdesk/rustdesk`
- Observed upstream HEAD: `0b3a1ddd80285c87baad495f79b54d19ef3ba4d9`
- Package snapshot observed as RustDesk `1.5.0`
- Headless controller work was implemented against `Session<T: InvokeUiSession>`.

## Included

- `headless_controller.rs`: current headless controller prototype.
- `bridge-Cargo.toml`: controller bridge prototype crate manifest, including the RustDesk root crate patch overrides required when RustDesk is consumed as a path dependency.
- `bridge-main.rs`: HTTP/JSON controller bridge prototype source.
- `rustdesk-build-env.Dockerfile`: reproducible Linux build environment used while isolating RustDesk dependencies.

## Build findings

- Modified RustDesk library: `cargo check --lib --no-default-features --features linux-pkg-config` reaches `exit 0` in the reproducible Docker build environment.
- Standalone bridge initially resolved crates.io `webrtc 0.13.0` instead of RustDesk's patched fork because dependency-root `[patch.crates-io]` entries are not inherited by dependents. This caused missing RustDesk fork APIs such as `set_no_congestion_control` and `set_ice_max_binding_requests`.
- Adding the same RustDesk patch overrides to the bridge manifest fixed that root cause. `cargo check` for `rustdesk-controller-bridge` then reached `exit 0`.
- A real debug binary was built and launched on loopback. Smoke tests passed:
  - `GET /health` -> `{"ok":true,"service":"rustdesk-controller-bridge","version":"0.1.0"}`
  - `POST /v1/action` with `{"action":"devices.list"}` -> `{"devices":[],"ok":true}`
- This verifies the first executable bridge transport boundary; no real remote-device authentication/E2E terminal connection has been claimed yet.
- Bot-side PR #100 remains separate/draft; this backup branch must not be merged directly.

## Architecture decisions to preserve

- Permanent devices: Settings > Integrations > RustDesk, permanent password required.
- Temporary devices: configured from chat, ephemeral connection only.
- Connection server is first-class for both permanent and temporary use: RustDesk Public, saved self-hosted profile, or one-time custom server.
- Authentication and connection-server selection are separate concerns (`WHO + WHERE + HOW`).
- Saved server profiles are separate from devices and can be reused across multiple devices.
- `question` handles non-secret user choices, permission handles action authorization, and secure input handles credentials.
- Model-facing actions must never expose raw credentials or private server keys.
