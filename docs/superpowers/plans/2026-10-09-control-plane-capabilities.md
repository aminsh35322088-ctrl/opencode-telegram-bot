# Control Plane capability integration implementation plan

Goal: make Cloudflare the authoritative encrypted credential and capability layer, with dedicated Topic Workers as isolated consumers.

Architecture: retain the signed Worker channel and exact Topic generation fence. Introduce a declared integration registry and generic acquisition, validation, and release. Root Worker consumers keep credential material out of the unprivileged model runtime; Core governs capability processes.

Production source path: Core upstream lock and patches plus runtime overlays → compiled headless Core → Core Dockerfile.worker → existing CI/prerelease Worker image job → digest in Bot control-config.ts → RailwayFleetDriver → dedicated /data volume and signed Topic node.

## Tasks

- [x] Trace production architecture and live Railway image/volume inventory.
- [x] Add Core generic opaque lease consumer tests: captured identity, expiration, replacement, revocation, sanitized errors, release, mock database integration.
- [x] Add Cloudflare generic broker tests: exact Worker/Topic/generation, capability and scopes, encrypted persistence, rotation, revocation, expiry, asynchronous authority fence.
- [x] Reproduce and fix Main-only account callback and credential-save scope enforcement.
- [ ] Connect canonical account storage and signed production transport to the generic broker; consolidate provider and MCP delivery without breaking existing runtime contracts.
- [ ] Implement repository-scoped Git transport using governed Core Git processes and privileged authentication proxy; verify fine-grained token authorization on repository use.
- [ ] Implement Core-owned governed Tailscale runtime using per-Worker private state; mint enrollment credentials in Cloudflare, retain management credentials only there.
- [ ] Preserve multiple GitHub accounts; separate credential removal, runtime disconnect, identity deletion, and rotation.
- [ ] Add cancellation, timeout, cleanup, crash/replacement, mock future integration and secret-flow regression coverage.
- [ ] Qualify Linux compiled artifact and existing CI; publish Core prerelease and immutable Worker candidate.
- [ ] Deploy Cloudflare, provision Railway candidate, verify real GitHub, Tailscale and SSH, sleep/wake identity persistence, rotation/replacement and resource measurements.
- [ ] Audit secrets, review both complete diffs twice, remove obsolete paths only after positive replacement qualification.

## Review focus

1. Fine-grained PAT repository membership is insufficient to prove token write permission.
2. Crypto/network awaits permit Durable Object interleaving: recheck account version and Worker authority before delivery.
3. Loopback alone does not isolate raw credential endpoints from model-driven shell processes.
4. tailscaled persistent state must be isolated from Topic workspace and global shared state.
5. Issued upstream PATs cannot be revoked by deleting a local lease: each transport request must reauthorize, and in-flight revocation needs bounded cancellation.

Verification: run Bot distributed Node tests, typecheck, lint, build; Core root Python suite and runtime Bun suite; upstream overlay and compiled headless tests; exact image live Railway qualification. Record actual results and deployment identities; do not infer live success from unit tests.
