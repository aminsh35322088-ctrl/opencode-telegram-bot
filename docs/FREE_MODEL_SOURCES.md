# Experimental Free Model Sources

This subsystem adds optional free model sources without changing the bot's stable provider path or its anti-stall behavior.

## Included sources

| Source | Login requirement | Transport/capability notes |
| --- | --- | --- |
| Gemini Web | zero-input Guest when the live probe succeeds; account cookies optional | text + real image transport + emulated tool calling |
| Qwen Web | Guest only when the live probe succeeds on the current host; account token otherwise | text + emulated tool calling; image transport is deliberately **not** advertised |
| GLM Web (Z.AI) | account/device token required for reliable chat | text + real image transport + emulated tool calling |
| DeepSeek Web | account token required; no guest mode | text + emulated tool calling |
| Freebuff | official browser login (automatic token capture) or one normal account token | curated free catalog; text/tool integration, upstream seat/quota/geography controls remain authoritative |
| OpenCode Zen | already native in OpenCode | not duplicated by this subsystem |

The feature is **OFF by default** under **Settings → Experimental → Free Model Sources**.

Credentials are managed under **Settings → API Connections → Free Model Sources**. Freebuff uses its official CLI-style browser login: the bot requests a login URL from Freebuff, the user approves it in the browser, then the bot reads the approved token from Freebuff's official status endpoint, verifies it against Codebuff, stores it privately, and reloads the runtime. Manual token paste remains available as a fallback.

For Guest-capable sources, model discovery alone is not treated as proof that chat works. After OmniRouter starts, the bot sends a minimal live completion through each Guest bridge. Only sources that pass that probe are injected into OpenCode's Model Center. A blocked Qwen Guest on a Railway/datacenter IP therefore shows **Account required on this host** instead of exposing models that will immediately return 401/403. Users can retry the Guest probe from API Connections after upstream/network conditions change.

The bot accepts at most one credential per source and does not expose multi-account pooling or token rotation. Qwen, GLM and DeepSeek do not currently expose an upstream device-code flow that a remote Telegram bot can safely complete on the user's behalf; their account-login fallback therefore still requires the user's own browser credential.

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
- Qwen: Vision = false in this bridge integration; guest access can be rejected from datacenter IPs, so account-token setup remains available
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
