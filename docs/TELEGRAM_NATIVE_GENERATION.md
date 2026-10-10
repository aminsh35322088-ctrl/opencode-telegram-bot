# Native generation in private AI Topics

Telegram Bot API 10.3 contract inspected on 2026-10-09/10:

- [sendRichMessageDraft](https://core.telegram.org/bots/api#sendrichmessagedraft) accepts a private `chat_id`, `message_thread_id`, stable nonzero `draft_id`, `rich_message`, `can_stop` and `keep_on_stop`.
- Rich thinking uses `InputRichBlockThinking` (`type: "thinking"`, safe `RichText`); completed planning summaries use `expandable_blockquote`. Neither field contains model reasoning, prompts, tool inputs or outputs.
- [MessageGenerationStopped](https://core.telegram.org/bots/api#messagegenerationstopped) carries `chat`, optional `message_thread_id`, and `draft_id`; there is no `from` field.
- Drafts are ephemeral 30-second previews. `keep_on_stop` retains a stopped preview temporarily, not permanently. This implementation uses `false` and never publishes partial output after accepted Stop.
- A persistent final response requires `sendMessage`/`sendRichMessage`. There is no documented atomic draft-to-message conversion or Stop-versus-persistent-send transaction. A Telegram request already accepted remotely cannot be recalled by a later webhook. Immediate restoration after persistent UI messages and between final chunks minimizes the resulting client transition; it must be checked in the real client, not claimed atomic from mocks.

The secure production runtime check confirmed that the allowlisted chat is private, private bot Topics are enabled, and existing AI Topic IDs are present. No Telegram token was exported.

## Ownership

`TelegramRunPresentationController` exclusively owns native draft identity and presentation. SQL binds chat/thread/session/worker/generation/run/draft. IDs are monotonic and never reused; active ownership and cancellation survive Durable Object restart. Histories retain at most four canned completed planning summaries, sixteen thinking/tool identities and one transient activity map. Terminal bindings retain a bounded tail per Topic; hot lookups use indexes created with the new table, without indexing old production history.

Every active draft sets `can_stop: true`. Updates coalesce at 1.5 seconds and quiet runs refresh every 10 seconds. Rate limits respect `retry_after`; in-flight leases survive restart. No per-token native presentation writes occur. Existing Core stream ingestion remains unchanged.

Cloudflare synchronously fences output when it accepts an authenticated, allowlisted private-chat Stop with exact durable ownership. It then uses existing signed Worker `stop`/`status` and Core cancellation. Unknown admission remains fenced until exact signed admission proof exists; a network timeout cannot release the queue. The bot does not duplicate Core process governance.

Execution idle enters presentation FINALIZING, blocking subsequent Topic runs until delivery. Ambiguous final receipts keep refreshable ownership and require the existing outbox reconciliation rather than a duplicate send. Final output continues to use the existing renderer, limits, code/document handling and RTL detection. Diff collection happens before final publication.

## Compatibility and UI

A definitive native API rejection records capability diagnostics, disables the rejected rich-draft path, and leaves execution intact. No inline button masquerades as native Stop. Legacy/unsupported-chat previews remain a separately owned compatibility path, and no longer capture or display raw reasoning. Existing live legacy previews are not migrated midway through a run.

Pause/Resume/Abort disappear from the Topic keyboard only after a real native Stop receipt and exact runtime cancellation qualification. Backend primitives and recognition of old keyboard text remain intact. ReplyKeyboard deletion still completes before action dispatch. Model Center, Settings, Compact, numbering and admitted OpenCode session titles keep their existing ownership.

Production qualification must separately establish API acceptance, stable updates, native client Stop visibility, actual Telegram Stop webhook delivery, exact Core cancellation and clean final persistence. Local mocks alone cannot establish these facts.
