# Experimental Free Model Sources

This subsystem adds optional free model sources without changing the bot's stable provider path or its anti-stall behavior.

## Included sources

| Source | Login requirement | Transport/capability notes |
| --- | --- | --- |
| Gemini Web | Guest works; account cookies optional | text + real image transport + emulated tool calling |
| Qwen Web | Guest works on some networks; token optional | text + emulated tool calling; image transport is deliberately **not** advertised |
| GLM Web (Z.AI) | account/device token required for reliable chat | text + real image transport + emulated tool calling |
| DeepSeek Web | account token required; no guest mode | text + emulated tool calling |
| Freebuff | one normal account token | curated free catalog; text/tool integration, upstream seat/quota/geography controls remain authoritative |
| OpenCode Zen | already native in OpenCode | not duplicated by this subsystem |

The feature is **OFF by default** under **Settings → Experimental → Free Model Sources**.

Credentials are managed under **Settings → API Connections → Free Model Sources**. The bot accepts at most one credential per source. It does not expose multi-account pooling or token rotation.

## Runtime architecture

The production image builds the MIT-licensed
[Godde3s/omnirouter](https://github.com/Godde3s/omnirouter)
at the pinned commit:

`ce94f1166c3c5168fe0e94d6fb83c002fbaa80ef`

One loopback-only process hosts all experimental sources:

```
OpenCode
  ├─ experimental-gemini-web   model=gemini/<id>
  ├─ experimental-qwen-web     model=qwen/<id>
  ├─ experimental-glm-web      model=glm/<id>
  ├─ experimental-deepseek-web model=ds/<id>
  └─ experimental-freebuff     model=freebuff/<id>
            │
            ▼
      127.0.0.1:8790
         OmniRouter
            │
      embedded web bridges
```

Every model sent to OmniRouter is provider-prefixed. OmniRouter resolves an explicit `provider/model` to exactly that provider, so this integration does **not** enable the router's `auto` or named combo fallback chains.

The sidecar also starts with:

- `HOST=127.0.0.1` — no public dashboard/API exposure;
- random per-process router, internal and admin secrets;
- `RTK=off` and `PROMPT_MODE=off` — no context/tool-output rewriting in this PR;
- `RETRY_PER_PROVIDER=1`;
- one credential per provider at most;
- persistent OmniRouter/GLM state under the bot application home.

OpenCode receives only the local OmniRouter router key through an environment reference. Provider credentials remain in the bot-owned app state file (mode `0600`) and are passed only to the loopback child process environment.

## Capability policy

The bot advertises the **effective transport capability**, not upstream marketing metadata:

- Gemini: Vision = true
- GLM: Vision = true
- Qwen: Vision = false in this bridge integration
- DeepSeek: Vision = false
- Freebuff: Vision = false conservatively
- all five expose tool calling through their compatibility layer

This prevents a model catalog from claiming image support when the selected bridge cannot actually transport an image.

## Explicit non-goals

This PR does **not** redesign or fix:

- stream watchdogs / idle timeouts;
- retry/backoff policy in the Telegram bot;
- smart provider/model fallback;
- context compaction;
- stuck/loop detection;
- Topic isolation;
- request checkpointing.

Those remain reserved for the dedicated anti-stall/runtime PR.
