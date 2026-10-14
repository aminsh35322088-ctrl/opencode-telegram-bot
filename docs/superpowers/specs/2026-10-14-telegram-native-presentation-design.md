# Telegram-Native Presentation Design

Status: design approved in project chat; implementation pending plan/review.
PR: #191
Target: `feat/native-run-presentation`
Date: 2026-10-14

## Purpose

Make the bot feel native to modern Telegram instead of treating Telegram as a plain-text terminal. The design preserves the existing final-answer semantics while adopting the useful parts of Bot API 10.1–10.3 that improve readability, topic-local interaction, long-run observability, and reviewability.

The implementation must remain safe under partial client/API support: every adopted Rich Message feature has a deterministic plain-text or existing-renderer fallback.

Official references:

- Bot API changelog: https://core.telegram.org/bots/api-changelog
- Bot API reference: https://core.telegram.org/bots/api
- Styled text/entities: https://core.telegram.org/api/entities
- Bot button styles: https://core.telegram.org/api/bots/buttons

## Product contracts

### 1. Reasoning

Reasoning remains independent from activity and the final answer.

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

The Activity presentation uses `InputRichBlockDetails` / `RichBlockDetails`:

- collapsed by default;
- summary stays short, e.g. `🛠 Activity · 12 actions`;
- body contains the detailed ordered activity history;
- repeated updates for the same tool call update the existing item rather than duplicating it;
- the same Activity message continues across multiple reasoning phases in the same run;
- activity remains separate from reasoning and final answer;
- credentials and other secret-shaped values are redacted before rendering;
- unbounded stdout, file contents, or raw tool payloads are not embedded verbatim.

If `details` delivery fails, fall back to the existing safe text/activity renderer rather than dropping activity.

### 3. Final answer

The primary answer remains visible by default and keeps the existing answer generation/finalization path.

The renderer may collapse optional secondary sections when the model explicitly emits an allowlisted details construct. Supported authoring form:

```html
<details>
<summary>Technical details</summary>

Markdown/body content
</details>
```

Rules:

- the main answer is never automatically collapsed;
- only allowlisted `details` markup is interpreted structurally;
- arbitrary HTML does not become arbitrary Telegram blocks/actions;
- nested details are bounded by the renderer nesting budget;
- code blocks, lists, tables, Persian/RTL text, and links inside details preserve their existing safe rendering semantics;
- fallback projection includes summary + body so no information disappears on older/unsupported clients.

### 4. Native date/time

Adopt Telegram native date/time representation where input is explicit and valid.

Preferred explicit authoring form:

```html
<tg-time unix="1760457600" format="...">fallback text</tg-time>
```

The parser validates the Unix timestamp and format string before producing a native date-time RichText node. Invalid input stays visible as ordinary text.

Use cases: deploy times, reset times, scheduled task times, soak deadlines, worker lifecycle timestamps.

Do not auto-convert arbitrary numbers/dates into Telegram date-time entities.

### 5. Native math

Adopt Telegram mathematical-expression primitives only through explicit syntax to avoid misclassifying currency or ordinary `$...` text.

Preferred explicit forms:

```html
<tg-math>E = mc^2</tg-math>
<tg-math-block>\int_0^1 x^2 dx</tg-math-block>
```

Inline math maps to RichText mathematical expression. Block math maps to the native mathematical-expression rich block. Invalid/unsupported expressions remain visible as text/code fallback.

### 6. Anchors and references

Adopt native anchors/references for long technical answers and evidence navigation where the model explicitly emits supported markup.

Goals:

- source/evidence sections can be referenced without duplicating large text;
- long answers can link internally to named sections;
- references must not create arbitrary external actions;
- unresolved/invalid references degrade to visible text.

The renderer must keep reference names local to the current rendered answer and must not accept them as callback identifiers or executable data.

### 7. Compact rich tables

Existing rich-table rendering stays in place. When a table is eligible for native rich rendering, set Telegram `is_compact` where doing so improves mobile readability.

Rules:

- existing width/column safety checks remain authoritative;
- large/unsupported tables keep the current preformatted fallback;
- compact mode is a presentation hint, not a semantic transformation;
- Persian/RTL cell text keeps the current direction-handling behavior.

### 8. Deterministic button styling

Use Telegram button styles only for bot-owned deterministic UI.

Recommended mapping:

- primary navigation/action → `primary`;
- confirmed/positive action → `success`;
- destructive action → `danger`;
- neutral/back/cancel → default.

Security rule: model output never creates arbitrary callback buttons, URLs, Mini App buttons, or destructive actions. Button callback data stays generated by the bot's existing routing layer.

### 9. Text color

Arbitrary text color is intentionally NOT implemented because the Bot API does not expose a custom text-color property for normal RichText. Telegram controls text colors according to client theme.

Supported visual emphasis remains semantic:

- bold/italic/underline/strikethrough;
- `marked` highlight;
- code/preformatted;
- spoiler;
- quote / expandable quote;
- headings/details/tables;
- styled buttons with Telegram-defined theme-aware colors.

No custom `#RRGGBB` text-color syntax will be invented.

## Existing contracts retained by this PR

The following #191 contracts remain in force and are documented together because they affect the same Telegram run lifecycle:

- exact-topic `typing...` using `message_thread_id` while a run is active;
- Remote Topic SDK compatibility for models/providers, agents, commands, permissions and question flows;
- governed Remote Topic context compaction via Core/Worker `session.compact`;
- `Compact Context` exposed from Context Health;
- final-answer rendering/finalization remains separate from reasoning/activity;
- Stop continues to target the exact active run.

## Compatibility strategy

### Capability tiers

The renderer treats Telegram capabilities as progressive enhancement.

1. Rich Message path: use native blocks when the installed Bot API/client path supports them.
2. Existing rich/plain renderer fallback: preserve readable content if a rich send/edit fails.
3. Never silently drop body content because a specific block is unsupported.

### Client/API behavior

Bot API 10.1 introduced Rich Messages and rich drafts. Bot API 10.2 added outgoing input rich blocks including Details. Bot API 10.3 added rich buttons, compact tables, expandable block quotations, draft Stop controls, and generation-stopped updates.

The bot must not assume every Telegram client visually implements every feature identically. The fallback text remains complete and readable.

## Security and privacy

- Never expose raw provider-private chain-of-thought.
- Redact token/API key/password/secret/credential shaped values from Activity.
- Do not render arbitrary tool input/output without bounded summarization.
- Model-authored markup is parsed through an allowlist, not passed to Telegram as raw object payloads.
- Model output cannot generate callback data, privileged buttons, Mini App launches, or destructive actions.
- Telegram URL sanitization rules already present in the renderer remain in force.
- Invalid rich constructs fall back to visible text instead of failing the entire answer.

## Parser / renderer architecture

### Internal block AST additions

Extend the internal Telegram block model with focused semantic nodes rather than embedding raw Bot API JSON:

- `details { summary, blocks }`
- `math_block { expression }`
- `anchor_block { name }` if block-level anchor support is needed by the final mapping

Extend inline nodes as needed for:

- `date_time`
- `math`
- `anchor`
- `anchor_link`
- `reference`
- `reference_link`

Existing `marked` support remains unchanged.

### Mapping layer

`block-parser.ts` owns safe parsing/validation.

`rich-blocks.ts` owns AST → Telegram RichText/RichBlock conversion.

`block-plain-text.ts` owns lossless-enough fallback projection.

`block-splitter.ts` / limits logic remains authoritative for chunking and bounded nesting.

Activity presentation is not authored through the final-answer parser; it is produced from trusted run activity state and rendered directly as a `details` block with a plain fallback.

## Fallback semantics

Every new construct needs an explicit fallback:

- details → `Summary\nBody`;
- date/time → supplied fallback text or ISO-like visible text;
- inline math → expression text/code;
- block math → preformatted expression;
- anchor → omitted from visible fallback unless it has display text;
- reference → visible reference label/text;
- compact table → existing table/preformatted output;
- styled button → same label/action without style if style is unsupported.

## Testing contract

No implementation is complete until tests cover at least:

- Activity renders as one native Details block and still redacts secrets;
- Activity updates reuse one message across tool kinds and reasoning phases;
- Details final-answer parsing with Markdown/code/list/table body content;
- malformed/unclosed Details fallback;
- nested Details depth limits;
- Persian/RTL inside Details;
- reasoning always persists as expandable blockquote;
- reasoning/activity/final answer remain separate;
- explicit date-time parsing + invalid timestamp fallback;
- inline and block math parsing + ordinary currency text not misclassified;
- anchors/references valid + unresolved fallback;
- compact table hint without changing table fallback rules;
- styled buttons are bot-owned only;
- rich-send failure falls back without content loss;
- UTF-16/entity and block/character limit regression coverage;
- full existing CI, lint, typecheck, build and diff-check.

## Documentation contract for PR #191

PR #191 is intended for later deep review by Codex/another strong model. Therefore every adopted behavior must be reviewable from the PR without relying on chat history.

Required PR documentation:

1. this design spec;
2. an implementation plan/checklist updated as work lands;
3. a Bot API capability matrix: adopted / already present / intentionally deferred;
4. parser syntax and fallback examples;
5. security/privacy rules;
6. compatibility notes and known client limitations;
7. test evidence and final CI run identifiers;
8. production evidence/root causes for the Remote Topic and typing fixes already included in #191;
9. explicit non-goals and deferred features.

## Deferred after evaluation

The following were evaluated but are not part of this PR unless a concrete product requirement appears during implementation:

- arbitrary text colors: unsupported by Bot API;
- model-generated callback or destructive buttons: rejected for safety/control ownership;
- model-generated Mini App actions: rejected for scope/security;
- ephemeral messages: useful mainly for shared group workflows, low value for the current private-topic architecture;
- arbitrary rich media/document embedding in final answers: useful but introduces file lifecycle/upload complexity and is not needed for the current presentation goal;
- premium-dependent custom emoji generation: inconsistent availability and not required for coding UX.

## Success criteria

The change is successful when Telegram looks and behaves like a first-class OpenCode client:

- the user can see live reasoning without losing it after completion;
- activity is compact by default but fully inspectable;
- long answers can collapse optional detail without hiding the main conclusion;
- dates, math, references and tables use native Telegram presentation where safe;
- topic typing/Stop/Remote Topic lifecycle remains correct;
- unsupported rich features never cause answer loss;
- the PR itself contains enough design, implementation, compatibility, security and verification evidence for an independent reviewer to audit it without reconstructing decisions from chat history.
