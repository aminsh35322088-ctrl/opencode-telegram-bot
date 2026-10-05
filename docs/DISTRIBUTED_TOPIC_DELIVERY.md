# Distributed Topic delivery ledger

## Deployed baseline

Bot commit `c73d7503a2e547444513a981cb22573e5209cf54` isolates the Railway
infrastructure credential in the privileged launcher before any shell or
application starts. Railway deployment
`b41297c8-bd29-4dd7-9aaf-403b1304c521` succeeded. Its runtime reported
`startup_environment_isolated application_uid=node`, recovered six existing
bindings and reported healthy startup checks. Production still uses local Core.

The control project is `b68f0bf0-568e-4030-9b6f-99afcbf6cc93`, production
environment `8121c848-81bb-4770-957b-4e438ed44336`, Bot service
`81e27262-cda4-445d-8463-abc60976accc`, dedicated 500MB volume
`e87ae897-33c4-4e76-b490-82d2ebcc1aaf`. The empty validation project
`fdad9783-aa9e-46ac-a2c9-d322cf79208c` is reserved for reuse as Workers-A.
No Worker projects/services or Topic mappings have been provisioned yet.

## Implemented integration foundations

Canonical state remains in the existing app-state store. Its serialized atomic
commit updates a hashed Global snapshot and revision; runtime and approval
journal changes do not increment Global. Model mutations use durable exact
Question approvals bound to node/generation/Topic/session/resource/config hash.
Existing Skill inspection/candidate menus and explicit Telegram management
flows are preserved. Secrets are excluded from snapshots. The model catalog
switches to canonical metadata only in explicitly enabled distributed mode.

The root-owned Node gateway authenticates bounded requests and durable replay
admission, then forwards a verified envelope over inherited IPC. Bot application
code never receives node signing keys or the Railway credential. Provider
credentials are leased in memory to the Worker Agent; only fixed authorized
provider operations are supported. Root infrastructure provisioning uses fixed
Railway mutations, a durable journal, ownership reconciliation and a 3+1 pool.
Signed streaming must acknowledge readiness before prompt dispatch.

Per-Topic SDK routing feeds existing Telegram rendering under Topic context.
Remote-bound operations never fall back to local AI. Unsupported SDK operations
fail closed. Slot reservations persist with a four-Topic cap; retirement fences
the generation before cleanup and holds capacity until cleanup completes.

## Verification and remaining gates

Local Bot verification: 42 distributed/routing/security tests and 2,223 existing
tests across 277 files passed; TypeScript and ESLint are required before publish.
Core compiled Worker probes verified real model/shell execution, signed events,
Question replies, pause/resume, stopping owned shell processes and restart
recovery inside a 1GB/two-CPU container. These are local execution results.

Still required: provisioner IPC and Telegram lifecycle wiring, deployment of
four Workers, complete MCP credential/action runtime integration, migration of
existing Topic state, real Telegram approvals and controls, crash isolation,
outage reconciliation, measured Worker resource use and Railway sleep/wake.
No local Core removal is authorized by these local results alone. Same-UID
local model access to Bot modules remains a transitional security limitation;
the final hard approval boundary requires Workers to exclude Bot code/state.

## Rollback

Before cutover, redeploy the known healthy Bot commit above and retain its
volume. Do not delete existing production Core resources or Topic state.
After remote provisioning, fence a failed node generation before replacing it;
preserve dedicated Topic storage until verified export/restore or product
deletion completes. Never activate an older snapshot over a newer known hash.
