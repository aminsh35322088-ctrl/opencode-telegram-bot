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

## Follow-up verification (2026-10-05)

Bot `ff3808b5e9c6166e670a18963ca63c7f0700593b` passed CI and Railway deployment `860ee5ef-1be0-4785-8551-cb25964e57b1` is SUCCESS, one running replica, no warnings or failures. Runtime logs show Bot startup, OpenCode ready, and healthy watchdog checks. Core `6597144f48f564a1f1163aa34025c643cedbeb1c` passed CI; its existing prerelease workflow is building pre.10.

Creating `opencode-topic-workers-b` in the current workspace was rejected by Railway with `Free plan resource provision limit exceeded. Please upgrade to provision more resources!`. Inventory still contains exactly the existing two projects. This is observed provisioning behavior, not a project-count assumption. No Worker services or volumes have been provisioned and no existing Topic has been migrated.

The root-only infrastructure IPC controller and gated Topic lifecycle are added in the follow-up change. The rollout gate stays disabled until Worker pools and runtime validation are available. `CONTROL_INFRASTRUCTURE_ENABLED=1` enables the narrow gateway independently of the AI routing gate. `TOPIC_NODE_CREATION_ENABLED=1` enables only new remote Topic creation after pools are configured; existing sessions require an explicit verified migration. Canonical ready bindings reconcile into the root identity store before execution. General/thread 1 never reserves a Worker. Retired remote Topics never fall back to local Core.

Interrupted approval commits reconcile against exact canonical receipts. An interrupted operation without canonical proof fails closed; ambiguous external effects require repair. Skill writes preserve a durable before/expected-byte journal and only restore bytes that exactly match the interrupted approved write.

## Merged Core and containment verification

Core PR #28 was reviewed against passing exact-head CI and existing compiled Railway validation, then merged as `e842fc746635d107a8a6495e6aadc447df95be50`. Candidate pre.12 commit `9e0f15273acc8cbc71dd86b24c98bf3a83e4c879` includes those fixes and an essential-child Worker supervisor: unexpected Core exit terminates the Worker container; only an intentionally stopped, joined exit-zero Core may be replaced locally. Physical SIGKILL caused exit 1, and a separate fresh container recovered the same synthetic session/snapshot volume. Request-bound ordered streams reject cross-stream replay without per-frame persistent writes.

Bot deployment `ab8acacd-6866-45f8-bffa-8eb4a6a3ef29` is SUCCESS, one running replica, no issues. Its root API observed `workspace_plan=HOBBY projects=2` and `worker_pools_unavailable stage=create category=resource_limit http=200`. This confirms an actual project-create resource rejection through the infrastructure controller; authentication was not reinvestigated. Preferred Workers-B creation remains blocked. Existing production resources are preserved, and Topic creation remains gated.

Request-driven reconnect restores the signed existing run into logical Core authority before streaming. Delete persists a logical binding tombstone before awaiting Root retirement, so already captured Telegram API methods (including raw methods) cannot emit late output. Failed cleanup remains fenced on retry. MCP lease authorization reuses the encrypted credential store and checks the exact canonical enabled server/reference/endpoint before decryption. Leases are memory-only; Worker MCP proxy integration remains pending.

The latest isolated Bot boundary run passed all 75 tests. The full existing regression suite passed 2,223 tests across 277 files; the pre.12 release workflow is being checked before rollout. Local Core is still retained; no remote cutover or four-Worker success is claimed.

## MCP runtime follow-up (2026-10-06)

Bot `d6ac637000b271664ec4245a4873fb687faad8a1` passed CI and deployed successfully as `21c888a2-57c2-4d82-9ce5-7ba475816b25`. Core pre.12 is published; its CI and prerelease workflows passed. The startup inventory reported six stored Topic bindings, Global revision 0, and zero Node bindings. Migration requires classifying those bindings and retaining at most four AI Topics; no existing data has been deleted.

Core `ac683948c3cd3ee697a6f38354e7e1a02e82cc30` adds the active-run MCP memory proxy for pre.13. All 105 Python tests passed (one platform skip). Actual compiled Core MCP discovery and a tool call passed with an offline upstream fixture; no startup/idle requests occurred. Pending leases and TCP/TLS establishment can be cancelled without blocking retirement. Unsupported transport configuration fails only that runtime capability. Live upstream TLS/credentials and four-Worker Railway behavior remain unproven. Existing Core smoke deployment `7b42c920-d367-4b16-a743-2e80493a3a24` is SUCCESS with `core_smoke_ready`; this is the existing validation service, not a Topic Worker.

With distributed mode enabled, Bot MCP operations now persist canonical definitions, desired enablement and encrypted credentials rather than synchronizing a local Core. Desired status is explicitly unverified until a Worker validates it. Control cannot start MCP stdio processes or execute MCP tools. OAuth operations require a future Worker-owned authorization flow. The new ownership test passes; 52 existing MCP tests also pass. Generated Action execution and Worker status reconciliation remain outstanding.
