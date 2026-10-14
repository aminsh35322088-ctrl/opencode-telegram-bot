# Telegram-Native Presentation Design

Status: approved in project chat; implementation plan written and awaiting final plan review.
PR: #191
Target: `feat/native-run-presentation`
Date: 2026-10-14

## Purpose

Make the bot feel native to modern Telegram instead of treating Telegram as a plain-text terminal. The design preserves final-answer semantics while adopting the useful parts of Bot API 10.1–10.3 that improve readability, topic-local interaction, long-run observability, and reviewability.

The implementation is progressive enhancement: every adopted Rich Message feature must have a deterministic readable fallback and must not change run ownership, security boundaries, or the final-answer lifecycle.

Official references:

- Bot API changelog: https://core.telegram.org/bots/api-changelog
- Bot API reference: https://core.telegram.org/bots/api
- Bot features / Rich Messages: https://core.telegram.org/bots/features
- Bot button styles: https://core.telegram.org/api/bots/buttons

## Implementation discovery: Core pre.34 already owns the rich grammar

The Bot is pinned to `@opencode-telegram/native-runtime` from Core `v1.18.33-bot.13-pre.34`.

That runtime already parses and renders the Rich Message primitives this PR wants to use:

- `details` blocks;
- inline and block mathematical expressions;
- `RichTextDateTime` via explicit `tg-time` syntax;
- anchors, anchor links, references and reference links;
- compact table metadata;
- rich-message buttons and Telegram button styles;
- expandable block quotations;
- normal Rich Message blocks and draft thinking blocks.

Therefore the Bot MUST NOT duplicate these grammars in a second parser. Final-answer syntax remains owned by Core/native-runtime. Bot-side work is limited to:

1. enabling/proving safe usage through the existing `renderTelegramParts()` pipeline;
2. keeping model-authored interactive buttons disabled by leaving `allowInteractiveButtons` off;
3. producing trusted Activity UI directly as a Rich `details` block;
4. styling only bot-owned deterministic keyboard/buttons;
5. preserving complete fallback text when rich delivery fails.

The Bot's older local render helpers remain compatibility/test utilities; they are not to become a competing authoritative parser.

## Bot API capability matrix

| Capability | Bot API | Core pre.34 | Decision | Bot usage |
| --- | --- | --- | --- | --- |
| Rich Messages / rich drafts | 10.1 | Present | Adopt / already present | Native answer/reasoning presentation |
| Rich Details blocks | 10.2 | Present | Adopt | Activity + model-authored optional answer sections |
| Expandable block quotation | 10.3 | Present | Adopt | Persisted visible reasoning |
| Compact rich tables | 10.3 | Present | Adopt / already wired in Bot pipeline | Mobile-friendly technical tables |
| Rich/styled buttons | 10.3 | Present | Adopt for bot-owned UI only | Primary/success/danger actions |
| Draft Stop controls + generation-stopped update | 10.3 | Present in runtime path | Retain with exact run ownership | Stop UX |
| Date/time entity / RichTextDateTime | 9.5 / 10.1 | Present | Adopt explicitly | Schedules, deploy/reset/deadline times |
| Rich math | 10.1–10.2 | Present | Adopt explicitly | Scientific/technical output |
| Anchors / references | 10.1 | Present | Adopt explicitly | Long answer navigation/evidence |
| Marked/highlight text | 10.1 | Present | Already supported | Semantic emphasis |
| Ephemeral messages | 10.2–10.3 | Not required | Defer | Low value for private-topic architecture |
| Rich media/document blocks | 10.1–10.3 | Present | Defer in model-authored answers | File lifecycle/upload complexity |
| Custom arbitrary text colors | — | — | Not supported | Do not invent |
| Model-generated callback/Mini App buttons | — | Parser can gate | Reject | Security/control ownership |

## Product contracts

### 1. Reasoning

Reasoning remains independent from Activity and the final answer.

Lifecycle:

1. visible/native live reasoning streams while the model is thinking;
2. the live presentation may use Telegram draft/thinking primitives;
3. when a visible reasoning section completes, it persists as its own message;
4. every completed reasoning section uses Telegram `expandable_blockquote`, regardless of length;
5. reasoning is never merged into the final answer;
6. private provider chain-of-thought is never promoted into visible reasoning merely because the transport supports rich blocks.

The previous short/long threshold is removed.

### 2. Activity / tool history

All model/tool execution activity for one run is represented by one run-owned Activity presentation rather than per-tool message spam.

Examples: Skill, Grep, Glob, Read, Edit, Write, Shell, Web, Task/Sub-agent, Todo and related status lines.

Activity uses `InputRichBlockDetails`:

- collapsed by default (`is_open` omitted);
- summary stays short, e.g. `🛠 Activity · 12 actions`;
- body contains the ordered activity history;
- repeated updates for the same call replace/update the existing item rather than duplicating it;
- the same Activity message continues across multiple reasoning phases in the same run;
- Activity remains separate from reasoning and final answer;
- credentials and secret-shaped values are redacted before both rich and fallback rendering;
- unbounded stdout, file contents and raw tool payloads are not embedded verbatim.

Delivery contract:

- initial Activity uses `sendRichMessage`;
- updates use `editMessageText` with `rich_message`;
- if a rich send/edit is rejected, use the existing safe text path so content is never lost;
- Topic routing must remain session/thread scoped.

### 3. Final answer

The main answer remains visible by default and keeps the current generation/finalization path.

Core/native-runtime already supports explicit optional sections such as:

```html
<details>
<summary>Technical details</summary>

Markdown/body content
</details>
```

Rules:

- the main answer is never automatically collapsed;
- model output goes through Core's allowlisted parser, not raw Bot API JSON;
- nested details obey the existing native-runtime/message nesting budgets;
- code, lists, tables, Persian/RTL text and links inside details preserve Core semantics;
- malformed/unsupported markup remains visible through fallback projection;
- Bot does not turn on `allowInteractiveButtons` for model-authored answers.

### 4. Native date/time

Use Core's explicit native date/time syntax only when the model intentionally emits it. Supported form:

```html
<tg-time unix="1760457600" format="D">fallback text</tg-time>
```

Core validates integer timestamps and Telegram-supported format strings before producing `RichTextDateTime`. Invalid input remains visible as text.

Use cases: deploy times, reset times, scheduled task times, soak deadlines and worker lifecycle timestamps.

Do not auto-convert arbitrary numbers/dates.

### 5. Native math

Use Core's existing math support. Explicit HTML is supported:

```html
<tg-math>E = mc^2</tg-math>
```

Core also supports Markdown math through its `remark-math` path, including block formulas. Tests must prove ordinary currency such as `$100` is not converted into math without a valid matching construct.

### 6. Anchors and references

Use Core's existing anchor/reference grammar for long technical answers and evidence navigation.

Goals:

- source/evidence sections can be referenced without duplicating large text;
- long answers can link internally to named sections;
- unresolved/invalid references remain visible;
- names are presentation identifiers only and never callback/executable data.

### 7. Compact rich tables

The Bot pipeline already applies `is_compact: true` to native rich tables. Keep that behavior and add explicit regression coverage.

Rules:

- Core/native-runtime remains authoritative for parsing/chunking;
- existing table width/column safety remains authoritative;
- large/unsupported tables keep readable fallback behavior;
- compact mode is presentation-only;
- Persian/RTL table text keeps current direction handling.

### 8. Deterministic button styling

Use Telegram button styles only for bot-owned deterministic UI.

Recommended mapping:

- primary navigation/action → `primary`;
- confirmed/positive action → `success`;
- destructive action → `danger`;
- neutral/back/cancel → default.

Initial high-value targets are destructive confirmation/delete controls and primary/positive confirmation actions. Avoid style churn on every neutral navigation button.

Security rule: model output never creates arbitrary callbacks, URLs, Mini App buttons or destructive actions. Callback data remains generated by the Bot's existing routing layer. Core's `allowInteractiveButtons` stays disabled for model-authored final answers.

### 9. Text color

Arbitrary text color is intentionally NOT implemented because Bot API has no custom text-color property for normal RichText. Telegram chooses theme-aware text colors.

Use semantic presentation instead:

- bold/italic/underline/strikethrough;
- `marked` highlight;
- code/preformatted;
- spoiler;
- quote / expandable quote;
- headings/details/tables;
- Telegram-defined button styles.

No custom `#RRGGBB` syntax will be invented.

## Existing contracts retained by PR #191

- exact-topic `typing...` using `message_thread_id` while a run is active;
- Remote Topic SDK compatibility for models/providers, agents, commands, permissions and question flows;
- governed Remote Topic context compaction via Core/Worker `session.compact`;
- `Compact Context` exposed from Context Health;
- final-answer rendering/finalization remains separate from reasoning/activity;
- Stop continues to target the exact active run.

## Compatibility strategy

Rich features are progressive enhancement:

1. native Rich Message path first;
2. existing readable text/entity fallback on rich send/edit failure;
3. never silently drop summary/body/action history because a block is unsupported.

Bot API milestones relevant to this PR:

- 10.1: Rich Messages, rich drafts, RichText types, `sendRichMessage`, `sendRichMessageDraft` and rich edits;
- 10.2: outgoing InputRichBlock types including Details and mathematical-expression blocks;
- 10.3: RichMessage buttons, compact tables and expandable block quotations.

Telegram clients may render these primitives differently; fallback text must remain complete.

## Security and privacy

- Never expose raw provider-private chain-of-thought.
- Redact token/API-key/password/secret/credential-shaped values from Activity.
- Do not render unbounded tool input/output.
- Model-authored markup is parsed by Core's allowlist, never accepted as raw Bot API objects.
- `allowInteractiveButtons` remains false for model-authored final answers.
- Model output cannot generate callback data, privileged buttons, Mini App launches or destructive actions.
- Existing URL sanitization remains authoritative.
- Invalid rich constructs degrade to visible content instead of failing the entire answer.

## Renderer architecture

### Authoritative final-answer path

`src/bot/render/pipeline.ts` delegates Markdown parsing, direction handling, chunking and Rich Message rendering to `@opencode-telegram/native-runtime`.

Core pre.34 owns:

- the semantic AgentDocument AST;
- rich HTML/Markdown parsing;
- Details/date-time/math/anchor/reference/button grammar;
- Telegram RichText/RichBlock conversion;
- bidi/Persian handling;
- rich document chunking and plain/entity projections.

The Bot SHOULD NOT reimplement those semantics in `block-parser.ts`/`rich-blocks.ts` unless a compatibility-only path specifically requires it.

### Trusted Activity path

Activity is Bot-owned runtime state, not model-authored answer Markdown. `tool-call-streamer.ts` keeps aggregation/dedupe semantics. A focused Activity renderer produces:

- trusted `InputRichMessageWithoutUpload` containing one `details` block;
- the same redacted content as a plain fallback string;
- a bounded action count for the details summary.

`event-subscription-service.ts` owns Topic-scoped send/edit delivery and fallback.

### Bot-owned button path

Existing menu/confirmation builders remain the sole source of callback data. Styling changes presentation only; routing semantics do not change.

## Fallback semantics

- Activity details → `🛠 Activity · N actions\n\n<body>`;
- final-answer details → Core plain projection includes summary/body;
- date/time → supplied visible text;
- inline/block math → visible expression in Core plain projection;
- anchors → no executable fallback side effect;
- references → visible reference text/label;
- compact table → existing table/plain projection;
- styled button → same label/callback without style if style is unavailable.

## Testing contract

No implementation is complete until tests cover at least:

- Activity renders as one native Details block and redacts secrets in rich and fallback forms;
- Activity updates reuse one message across tool kinds and reasoning phases;
- rich Activity send/edit failure preserves content via text fallback;
- final-answer `<details>` passes end-to-end through `renderTelegramParts()` with Markdown/code/list/table body content;
- malformed/unclosed Details remain visible;
- nested Details respect native-runtime limits;
- Persian/RTL inside Details remains valid;
- reasoning always persists as expandable blockquote;
- reasoning/activity/final answer remain separate;
- valid/invalid explicit date-time behavior;
- inline/block math plus ordinary currency non-regression;
- anchors/references valid plus unresolved fallback;
- compact table hint without changing fallback semantics;
- model-authored interactive buttons stay disabled;
- selected bot-owned buttons receive only deterministic primary/success/danger styles;
- UTF-16/entity and block/character limit regression coverage;
- all existing typing, Stop, Remote Topic and compaction tests remain green;
- full lint, typecheck, build, top-level tests, CI-only tests and diff-check.

## Documentation contract for PR #191

PR #191 is intended for deep review by Codex/another strong model. Every adopted behavior must be reviewable without chat history.

Required PR documentation:

1. this design spec;
2. `docs/superpowers/plans/2026-10-14-telegram-native-presentation.md` as the authoritative implementation plan/checklist;
3. Bot API capability matrix (adopted / already present / deferred);
4. supported authoring syntax + fallback examples;
5. security/privacy rules;
6. Telegram/client compatibility notes;
7. production root-cause evidence for typing/Remote Topic fixes;
8. full test evidence and final GitHub Actions run IDs;
9. explicit deferred/non-goal decisions;
10. explicit note of which capabilities are implemented by Core pre.34 versus Bot-owned code.

## Deferred after evaluation

- arbitrary text colors: unsupported by Bot API;
- model-generated callback/destructive buttons: rejected for safety/control ownership;
- model-generated Mini App actions: rejected for scope/security;
- ephemeral messages: low value for the current private-topic architecture;
- arbitrary rich media/document embedding in model final answers: file lifecycle/upload complexity;
- premium-dependent custom emoji generation: inconsistent availability and unnecessary for coding UX.

## Success criteria

The change is successful when Telegram behaves like a first-class OpenCode client:

- live reasoning remains visible and persists after completion;
- Activity is compact by default but fully inspectable;
- optional answer detail can collapse without hiding the main conclusion;
- dates, math, references and tables use native Telegram presentation where Core safely supports them;
- Topic typing/Stop/Remote Topic lifecycle remains correct;
- unsupported rich features never cause answer loss;
- Bot does not duplicate functionality already owned by Core/native-runtime;
- the PR itself contains enough design, implementation, compatibility, security and verification evidence for an independent reviewer to audit it.