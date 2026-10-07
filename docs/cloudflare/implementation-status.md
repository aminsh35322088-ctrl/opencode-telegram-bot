# Cloudflare execution-fleet foundation

This is an incremental, disabled foundation, not a production cutover.
Do not connect the production Telegram webhook or enable provisioning yet.
No Railway-hosted Control Plane should be created.

Implemented components:

- Cloudflare-only ingress, webhook authentication, durable update admission and alarms.
- SQLite schema versions 1/2 for backend/project/Worker/Topic inventory, allocation
  journal, bootstrap receipts, replay admission, FIFO runs, global revisions and leases.
- Atomic lazy reservations, backend capacity, configurable project sharding,
  deterministic project/service reconciliation and explicit quota failures.
- Railway execution driver using immutable image digests, dedicated volumes,
  serverless configuration and exactly two bootstrap variables.
- AES-GCM credentials scoped to backend or node/generation, WebCrypto signed transport.
- Core one-time bootstrap with a private durable node credential cache; old bootstrap
  remains source-compatible until new execution is verified.
- Existing Telegram native rich renderer and Persian/RTL support reused in Cloudflare.

Provisioning is disabled in wrangler.jsonc. The pinned pre.17 image predates the new
bootstrap client. Publish a compatible Core image through the existing release
workflow, verify its digest/build identity, then update the three Worker artifact
variables together. Enabling provisioning requires an explicit environment setting
PROVISIONING_ENABLED=true; an immutable image alone does not prove compatibility.

Required protected Cloudflare bindings:

- CREDENTIAL_MASTER_KEY: base64-encoded 32-byte AES-GCM key, Worker Secret.
- TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, ADMIN_TOKEN: Worker Secrets.
- CONTROL_PLANE_URL: the deployed HTTPS origin.
- TELEGRAM_ALLOWED_USER_IDS: explicit comma-separated admission list.

Railway backend registration accepts a token at authenticated POST /admin/backends
and immediately encrypts it using the master key. Backend tokens never belong in
Railway service variables. Inventory responses omit encrypted credential fields.
Queues are opencode-worker-jobs and opencode-worker-jobs-dead. CONTROL binds the
ControlPlane SQLite Durable Object with migration control-v1.

Still required before production activation:

- Topic Durable Object integration, Telegram Topic finalization and complete UI/commands.
- Worker readiness/version observation and secure assignment/cleanup/key handoff.
- Async signed Worker event delivery, rendering receipts and retry reconciliation.
- Provider credential proxy, questions/approvals and complete canonical snapshot contract.
- Lost-bootstrap-response recovery and ambiguous bare-volume reconciliation.
- Worker wake/recovery, bounded capacity-error UI, backend retry/rollover on real quotas.
- Production Cloudflare deployment/logs, compatible image release, zero-project
  Railway provisioning and real model/Telegram end-to-end acceptance.

Store unit tests verify state operations, not actual Worker cleanup or reuse.
Driver tests simulate Railway receipts; no live project or image observation is claimed.
