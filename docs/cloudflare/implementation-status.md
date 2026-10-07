# Cloudflare control-plane deployment status

Production target: `opencode-control-plane` at `https://opencode-control-plane.amin3532.workers.dev`. `wrangler.jsonc` is the source-controlled configuration. Deploy with existing credentials and `wrangler deploy --keep-vars`; preserve dashboard secrets and admission configuration. No additional GitHub Actions workflow is required.

Cloudflare owns SQLite registry/schema migrations, Topic ownership, provisioning journal, revisioned configuration, bootstrap consumption, encrypted node credentials, signed dispatch and callback admission. Railway provisioning is isolated behind `RailwayFleetDriver`. The default backend reads the Railway credential exclusively from `env.RAILWAY_API_TOKEN`; durable storage contains a binding reference, never the Railway token.

The configured production policy is 10 Workers across at most 2 lazily created projects, 5 Workers per project. There is no pre-provisioned fleet or independent Topic limit. General is not writable. Topic reservations are transactional and idempotent. Topic activation requires signed runtime health/version verification and a Core session. Signed callbacks fence node/generation/Topic/session/run and persist receipts before acknowledgement. Telegram final delivery uses the existing native block/RTL renderer with per-chunk durable delivery receipts.

Deletion fences first. This integration currently destroys the service and volume, verifies service deletion and volume deletion acknowledgement before releasing compute capacity. Railway retains deleted detached volumes for up to 48 hours; the provider purge timestamp is kept in the Worker audit record, and that Worker/volume is never reused. Safe production reuse is intentionally unavailable until Core cleanup/rebind is proven. Existing lower-level reuse tests are not a deployed reuse canary. Ambiguous Telegram delivery and lost bootstrap admission stop with explicit reconciliation state; they do not silently duplicate messages or provision another Worker. Bootstrap readiness has a 20-minute deadline.

## Activation gate

`PROVISIONING_ENABLED=true` enables the single canary against the verified pre.21 image with explicit authenticated API-client identity. The exact pre.21 image digest, Core commit/version, SDK checksums, and materialized release manifest have been verified. Core pre.21 enforces the admitted configuration revision and rejects stale idle callbacks before a new turn starts. This activation is a canary gate, not evidence of successful production model execution. The registry starts with no owned projects or Workers.

Telegram webhook connection, live model execution, Worker reuse, live project rollover, sleeping wake, automated replacement recovery, and Settings/Models/Questions/Actions/Extensions/MCP/Skills/Plugins UI parity are not claimed complete. The source retains the older Node Bot control path until its replacement is tested; no Railway-hosted Bot/Control service is recreated.

Local verification is recorded in the task evidence report. Unit tests and a deployed `/health` endpoint do not constitute Telegram -> Cloudflare -> Railway -> OpenCode -> Telegram acceptance.

## Direct connector deployment

After uploading a Worker bundle through the Cloudflare API, explicitly activate the returned version at 100% using the deployments API. Verify both `/health` and authenticated `/admin/runtime`; an uploaded bundle alone is insufficient evidence that the Durable Object serves the new code. Preserve `secret_text` and admission bindings throughout deployment. Never export secret values.

The supplied canary chat `1802392273` is a Telegram private chat. Live Telegram metadata confirms that this bot has private Topics enabled; no group-ID conversion is required. The canonical canary model is `opencode/big-pickle`; execution requires an authenticated Core model-catalog preflight and never invents provider credentials.
