# Cloudflare control-plane deployment status

Production target: `opencode-control-plane` at `https://opencode-control-plane.amin3532.workers.dev`. `wrangler.jsonc` is the source-controlled configuration. Deploy with existing credentials and `wrangler deploy --keep-vars`; preserve dashboard secrets and admission configuration. No additional GitHub Actions workflow is required.

Cloudflare owns SQLite registry/schema migrations, Topic ownership, provisioning journal, revisioned configuration, bootstrap consumption, encrypted node credentials, signed dispatch and callback admission. Railway provisioning is isolated behind `RailwayFleetDriver`. The default backend reads the Railway credential exclusively from `env.RAILWAY_API_TOKEN`; durable storage contains a binding reference, never the Railway token.

The configured production policy is 10 Workers across at most 2 lazily created projects, 5 Workers per project. There is no pre-provisioned fleet or independent Topic limit. General is not writable. Topic reservations are transactional and idempotent. Topic activation requires signed runtime health/version verification and a Core session. Signed callbacks fence node/generation/Topic/session/run and persist receipts before acknowledgement. Telegram final delivery uses the existing native block/RTL renderer with per-chunk durable delivery receipts.

Deletion fences first. This integration currently destroys the service and volume, verifies their physical absence, and only then releases capacity. Safe production reuse is intentionally unavailable until Core cleanup/rebind is proven. Existing lower-level reuse tests are not a deployed reuse canary. Ambiguous Telegram delivery and lost bootstrap admission stop with explicit reconciliation state; they do not silently duplicate messages or provision another Worker. Bootstrap readiness has a 20-minute deadline.

## Activation gate

`PROVISIONING_ENABLED=false` remains intentional. The checked-in pre.17 image digest is the last published artifact and predates the two-variable Cloudflare bootstrap. Do not enable provisioning against it. Core pre.18 adds owned signed event callbacks and durable prompt admission/recovery receipts. First publish its verified release/image through the existing Core prerelease workflow, pin its exact digest/commit/version here, verify the image actually boots, then enable lazy provisioning.

Telegram webhook connection, live model execution, Worker reuse, live project rollover, sleeping wake, automated replacement recovery, and Settings/Models/Questions/Actions/Extensions/MCP/Skills/Plugins UI parity are not claimed complete. The source retains the older Node Bot control path until its replacement is tested; no Railway-hosted Bot/Control service is recreated.

Local verification is recorded in the task evidence report. Unit tests and a deployed `/health` endpoint do not constitute Telegram -> Cloudflare -> Railway -> OpenCode -> Telegram acceptance.
