# RustDesk Lab emergency backup

Created from the live GitHub Lab work before runner reset risk.

## RustDesk upstream baseline

- Upstream repository: `rustdesk/rustdesk`
- Observed upstream HEAD: `0b3a1ddd80285c87baad495f79b54d19ef3ba4d9`
- Package snapshot observed as RustDesk `1.5.0`
- Headless controller work was implemented against `Session<T: InvokeUiSession>`.

## Included

- `headless_controller.rs`: current local headless controller prototype from the Lab runner.
- `bridge-Cargo.toml`: controller bridge prototype crate manifest.
- `bridge-main.rs`: current HTTP/JSON controller bridge prototype source.
- `rustdesk-build-env.Dockerfile`: reproducible Linux build environment used while isolating RustDesk dependencies.

## Build findings

- `cargo check --lib --no-default-features --features linux-pkg-config` for the modified RustDesk library reached `exit 0` after providing the required Linux development libraries and a local `libyuv.pc` shim.
- The separate bridge crate build later hit RustDesk git dependency resolution for `tray-icon` when Cargo did not reuse the upstream lockfile; copying the upstream `Cargo.lock` into the prototype was the next mitigation.
- Bot-side PR #100 remained separate/draft; this branch is only an emergency backup of Lab-side work and must not be merged directly.

## Architecture decisions to preserve

- Permanent devices: Settings > Integrations > RustDesk, permanent password required.
- Temporary devices: configured from chat, ephemeral session only.
- Connection server is first-class for both permanent and temporary use: RustDesk Public, saved self-hosted profile, or one-time custom server.
- Authentication and connection-server selection are separate concerns.
- Model-facing actions must not expose credentials.
