# Dynamic Worker provisioning — approved first slice

Authority: user-approved Cloudflare migration architecture and first-slice acceptance list.
Execution: implement inline in existing Bot/Core repositories; preserve production local Core.

1. Extend existing Node tests to demonstrate dynamic reservations, free Worker reuse,
   duplicate allocation, deterministic project rollover and typed capacity failures.
2. Extract Railway-specific resource lifecycle behind a provisioning driver. Retain
   durable journal, fixed operation identity, ownership checks and minimal bootstrap.
   Replace source builds with immutable image digests for new Workers; existing
   Workers remain reconcilable without forced image migration.
3. Remove fixed four-Worker admission/registry limits and slot-based placement.
   Bootstrap reconciles existing persisted Workers; New Chat allocates on demand.
4. Add Core-owned runtime identity reporting and publish a prebuilt governed image
   through the existing release workflow, without adding a workflow. Verify build
   metadata, use an exact digest, and preserve all tool/runtime dependencies.
5. Run Node boundary tests, lint/typecheck/build, wider CI tests and Core tests.
   Push authorized changes and inspect each resulting Railway deployment/logs.
6. Validate image provisioning, reuse, fencing and capacity behavior. Review again
   for races, leaks, auth/replay/secret exposure and topology remnants; rerun regressions.

Cloudflare ingress/DO implementation begins only after this slice is demonstrably
healthy. Deployment/canary evidence and any blockers must be reported explicitly.
