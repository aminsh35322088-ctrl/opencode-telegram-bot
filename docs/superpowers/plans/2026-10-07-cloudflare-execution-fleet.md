# Cloudflare execution fleet implementation plan

The user's latest architecture is the approved specification. Existing Railway IDs are obsolete and must never be used as allocator defaults. Implement inline, with test-first changes and direct authorized main commits; no new workflows.

1. Add Cloudflare-native SQLite control storage with schema migrations: encrypted backend registry, project/Worker inventory, allocation jobs, Topic bindings, one-time bootstrap receipts, generation/replay fences, global revisions and durable execution/outbox records. Extend existing node:test tests against real SQLite and WebCrypto.
2. Add an API driver for execution-only Railway backends. Reconcile deterministic project/service operation names, create the first/next project lazily, deploy the existing immutable image, attach an owned volume, configure only bootstrap credentials and serverless sleep. Persist every external step before proceeding. Test zero-project bootstrap, configurable sharding, quota and crash retries.
3. Add Worker ingress, SQLite Durable Objects, Queue provisioning/recovery dispatch, authenticated admin setup and Telegram webhook ingress. Reuse the pure Telegram native/RTL rendering pipeline. Build with Wrangler; do not bundle Node execution services.
4. Extend Core's existing agent with short-lived one-time bootstrap and signed asynchronous run/event transport. Maintain compiled-image identity, snapshot verification and governed cleanup. Release using the existing prerelease mechanism and update the pinned image after verification.
5. Implement transactional New Chat, per-Topic durable execution ordering, approvals, global revision refresh, sleeping wake, Topic deletion/reuse and fenced recovery. Preserve old source modules until tested replacements cover their responsibilities; Cloudflare never imports local Core or child-process modules.
6. Run existing Bot/Core suites and review. Deploy the Control Plane, configure secrets and the Telegram webhook, then prove real model execution, second Topic isolation, project-six rollover and service reuse. Report blockers honestly; tests cannot substitute for real E2E.

Deployment dependency: Cloudflare deployment/account access and protected Telegram/Railway/provider credentials must be available to the privileged setup boundary. Never put these into ordinary Worker environments or model context.
