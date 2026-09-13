# Experimental Free Model Detection

Global Settings → Experimental (immediately above Advanced) → Free Model Detection.
Default: OFF. The switch persists across restarts and applies to all Topics.

When enabled, the existing Model Center provider list gains one price dot per
model and an “ⓘ Colors” Telegram alert. Selection and favorite buttons retain
their existing purpose. The current model uses a check mark in colored lists
so green always means price evidence. No extra sections, automatic inference
probes, timers or availability badges are introduced.

Order: advertised free, conditional free pricing tiers, weak free hints, unknown,
conflicting evidence, paid. Green means advertised plain-text inference pricing;
account eligibility, quotas and optional image/audio/search charges are not
verified. A successful request never promotes a model's price rank.

## Evidence and lifecycle

- Existing custom-provider discovery/refresh shares a bounded 5-minute catalog
  cache and concurrent GET requests. Raw price evidence stays separate from
  the configured model allowlist; discovery never enables extra models.
- Price views only read this cache; no network call is initiated by coloring.
  On a cold cache, models can initially be gray. The normal background catalog
  refresh supplies evidence for the next opening.
- Required text input/output prices must both be present to infer zero pricing.
  Contradictory flags or aliases are orange, malformed/incomplete prices remain
  unknown or hints. Unrecognized cost dimensions block a free inference.
- The official :free convention is trusted only on HTTPS openrouter.ai.
  Other providers can advertise explicit free flags or complete numeric pricing.
- Generic OpenCode runtime zero estimates remain gray. Built-in `opencode`
  models using the official HTTPS `opencode.ai/zen/v1` endpoint use their
  catalog prices: complete zero text/cache costs are green. Nested cache costs
  and `experimentalOver200K` tiers are normalized before classification.
  An endpoint override or incomplete costs cannot gain a green label merely
  through a provider ID or a model name containing `free`.
  Positive runtime prices can be shown as paid.
- Evidence older than 15 minutes is not used for newly opened views. Failed
  refreshes retain the last successful catalog with its original timestamp;
  a 30-second cooldown prevents repeated failed refreshes.
- Each colored menu has a bounded 15-minute snapshot. Pagination/favorites keep
  its order; reopening receives updated evidence. API URL/key/model-config
  changes invalidate that snapshot. Expired menus ask users to reopen.
- Toggling clears price views; late asynchronous results are discarded.
  Normal catalog refresh continues because it is shared core functionality.
- Cache keys hash configuration credentials. No credentials are written to
  price records or callback data. No dependencies or infrastructure are added.

Tests live in .github/ci-tests/tests so the existing CI materialization runs them.
The feature is experimental: it classifies advertised prices, not guaranteed
account-specific billing or inference availability.
