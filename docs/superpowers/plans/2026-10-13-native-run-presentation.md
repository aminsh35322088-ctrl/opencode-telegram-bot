# Native Run Presentation Implementation Plan

> Status: superseded by the approved Telegram-native presentation design before further implementation.

This plan originally covered reasoning persistence, aggregated activity, typing, Remote Topic SDK compatibility, and context compaction for PR #191.

The scope expanded on 2026-10-14 to include Bot API 10.1–10.3 native presentation features. The authoritative design is now:

`docs/superpowers/specs/2026-10-14-telegram-native-presentation-design.md`

Do not continue implementation from this file until the new design spec has been reviewed. After approval, regenerate the implementation plan from the new spec so that every code change, compatibility decision, security rule, fallback, and test maps back to a documented requirement.

## Previously completed work to carry forward

- completed visible reasoning persists separately from final answer;
- every completed reasoning section uses expandable blockquote;
- one run-owned Activity stream aggregates default/subagent/todo/tool activity;
- credential-shaped values are redacted from Activity;
- exact-topic typing uses `message_thread_id`;
- Remote Topic SDK routes provider/agent/command/permission/question reads and replies through Worker/Core RPC;
- governed Remote Topic context compaction maps `session.summarize` to `session.compact` and waits for the real `session.compacted` event;
- `Compact Context` is exposed from Context Health;
- final-answer generation/finalization remains separate from reasoning/activity.

## New plan requirements

The regenerated plan must additionally cover:

- Activity migration from expandable quote to native RichBlockDetails;
- allowlisted `<details><summary>…</summary>…</details>` in final answers;
- explicit native date/time syntax and fallback;
- explicit inline/block math syntax and fallback;
- native anchors/references with safe fallback;
- compact rich-table hinting;
- deterministic bot-owned button styling;
- capability/fallback matrix and Bot API compatibility documentation;
- full regression tests for Persian/RTL, limits, malformed markup, unsupported rich sends, and content-preserving fallback;
- documentation updates inside PR #191 sufficient for independent Codex/model review.

## Constraints that still apply

- final answer remains separate from reasoning/activity;
- no private provider chain-of-thought exposure;
- no arbitrary model-generated callback/destructive buttons;
- no custom text-color API is invented;
- no merge or production deployment is part of PR #191;
- implementation must end with full lint, typecheck, build, test, diff-check, and GitHub Actions evidence.
