# Free Model Detection — Bug Report

**Branch:** `bug-report-free-model-detection`
**Affected file:** `src/app/services/image-ai-provider-service.ts`
**Scope:** Architecture of dynamic free-model detection & cost-aware routing (fork-only code; the file does not exist upstream).

This document lists every bug found in the free-model detection architecture. Bugs marked **[verified]** were confirmed empirically with isolated unit/integration tests against this exact source.

---

## Severity Legend

| Severity | Meaning |
|----------|---------|
| CRITICAL | Breaks free-model detection entirely, or causes silent wrong behavior / data loss |
| HIGH     | Real logic/performance flaw that affects correctness or costs |
| LOW      | Edge case, robustness, or maintainability issue |
| RISK     | Design tradeoff worth documenting |

---

## CRITICAL

### C1 — Failed discovery poisons the cache for 10 minutes **[verified]**
```ts
let candidates: Candidate[] = [];
try { candidates = provider.id === HUGGINGFACE_ID ? await discoverHuggingFace(key) : await discoverCatalog(provider.baseURL, key); }
catch (error) { logger.warn(...); }
...
discoveryCache.set(cacheKey, { expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS, candidates: merged }); // runs on error too
```
When discovery throws (transient network error, 5xx), `candidates` stays `[]` and the empty list is cached for `DISCOVERY_CACHE_TTL_MS` (10 min). No free models are discovered for 10 minutes after any transient failure.

**Verification:** after a first call where `/models` threw, a second call with a healthy `/models` endpoint made **zero** new discovery requests (`expected 2 > 2` → false).

**Fix:** only write to `discoveryCache` when the discovery succeeded (and cache `undefined`/skip on error).

---

### C2 — Merge-dedup discards the discovered FREE candidate for the configured model **[verified]**
```ts
const configured: Candidate[] = [{ model: provider.model, capability: "generate", costTier: 1, source: "configured" }];
...
const merged = [...configured, ...candidates.filter((c) => !configured.some((x) => x.model === c.model && x.capability === c.capability))];
```
Discovered candidates are deduplicated by `model` + `capability` against the `configured` stub. The `configured` stub is hardcoded `costTier: 1` (unknown). So when the catalog correctly reports the configured model as **free** (`costTier: 0`), that accurate free candidate is dropped and the hardcoded unknown-cost stub wins.

**Effect:** the configured model is never tagged as free even when the provider says it is — the core of free-model detection is defeated for the default model.

**Verification:** catalog returned `configured-model` with all-zero pricing; log still showed `costTier=1`.

**Fix:** prefer the discovered candidate's `costTier` when both refer to the same model/capability, or skip the stub when a discovered entry exists.

---

### C3 — `DISCOVERY_LIMIT` is applied BEFORE the image-model filter **[verified]**
```ts
for (const item of asList(body).slice(0, DISCOVERY_LIMIT)) {
  if (!isImageModel(item)) continue;
```
The catalog is sliced to the first 20 entries and **then** filtered for image models. In OpenAI-compatible catalogs (OpenAI, Together, Groq, etc.) the first 20 entries are usually text models, so zero image models are discovered even when the catalog has hundreds.

**Effect:** for most custom providers, discovery effectively returns nothing.

**Verification:** an image model placed at catalog index 20+ was never discovered (`expected false to be true`).

**Fix:** filter first, then limit: `asList(body).filter(isImageModel).slice(0, DISCOVERY_LIMIT)`.

---

### C4 — `configureImageAiProvider` mutates the module-level `DEFINITIONS` constant **[verified]**
```ts
const definition: ImageAiDefinition = ... : DEFINITIONS[id as ...];   // reference, not a copy
if (options?.editModel?.trim()) definition.editModel = options.editModel.trim(); // MUTATES shared constant
```
For built-in providers (`pollinations`, `huggingface`), `definition` is a reference to the shared `DEFINITIONS` object. Setting `editModel` permanently mutates it for the process lifetime.

**Effect:** a later `configureImageAiProvider("pollinations", key)` **without** `editModel` still inherits the previously set `editModel` — stale state leaks across configuration calls.

**Verification:** after `configureImageAiProvider("pollinations", "k1", { editModel: "stale" })` followed by `configureImageAiProvider("pollinations", "k2")`, the stored provider still had `editModel: "stale-edit-model"`.

**Fix:** clone the definition before mutating, e.g. `{ ...DEFINITIONS[id] }`.

---

### C5 — Pollinations image editing silently drops the uploaded image **[verified]**
```ts
if (provider.id === POLLINATIONS_ID) {
  const response = await fetchRetry(`${provider.baseURL}/images/${candidate.capability === "edit" ? "edits" : "generations"}`, {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: candidate.model, prompt, n: 1, response_format: "b64_json" }), // image never included
  });
```
The Pollinations branch never reads the `image` / `mimeType` arguments. `editImageWithFallback` routes to `/images/edits` with a prompt-only JSON body.

**Effect:** editing an image on Pollinations produces a brand-new generation, not an edit of the provided image — silent wrong behavior.

**Verification:** the `/images/edits` request body contained no `image`/`image_file` field (`expected false to be true`).

**Fix:** either support multipart edit for Pollinations, or explicitly fail with a clear "editing not supported" error instead of silently generating.

---

## HIGH

### H1 — Fallback URL doubles the `/v1` suffix when baseURL ends with `/v1` **[verified]**
```ts
const base = baseURL.replace(/\/$/, "");
try { body = await requestJson(`${base}/models`, key); }
catch { body = await requestJson(`${base}/v1/models`, key); }
```
For `baseURL = "https://gw.test/v1"` the first attempt is correct (`…/v1/models`); the fallback becomes `…/v1/v1/models`, which is wrong.

**Verification:** a request to `/v1/v1/models` was observed (`expected true to be false`).

**Fix:** normalize the base URL once (strip a trailing `/v1`) and always append `/models`.

---

### H2 — Unknown-cost (tier 1) models are kept and attempted with the user's key
```ts
if (costTier === 2) continue; // only PAID models excluded
```
Tier 1 (unknown pricing) discovered models remain candidates and are called in `runCandidate` using the user's API key.

**Effect:** a user with a paid gateway can unexpectedly incur charges on models that were never confirmed free.

**Fix:** only include tier-0 (confirmed free) models in discovery, or surface unknown-cost models behind an explicit opt-in.

---

### H3 — `is_free: "true"` (string) is not recognized
```ts
if (model.is_free === true || model.free === true) return 0;
```
Strict equality ignores string values. Some providers return `is_free: "true"` as a string.

**Effect:** genuinely free models are misclassified as tier 1 (unknown).

---

### H4 — `editCapable` regex-matches the entire serialized model
```ts
const text = JSON.stringify(model).toLowerCase();
return /image-edit|image-to-image|inpaint|kontext/.test(text);
```
Any occurrence of these substrings anywhere in the JSON (id, description, tags) marks the model as edit-capable.

**Effect:** models whose docs merely mention "inpaint" are routed to the `/images/edits` endpoint and fail.

---

### H5 — `isImageModel` id-regex false positives
```ts
/flux|stable-diffusion|imagen|nano.?banana|gpt-image|kontext/.test(id)
```
Text models whose id contains e.g. `flux` (e.g. a prompt-helper model) are treated as image models and attempted on image endpoints.

---

### H6 — Hugging Face discovery is very slow (5 concurrent × 20s timeout each)
```ts
for (let index = 0; index < catalog.length && result.length < DISCOVERY_LIMIT; index += HF_CONCURRENCY) {
  const batch = catalog.slice(index, index + HF_CONCURRENCY);
  const discovered = await Promise.all(batch.map(async (model) => { ... await requestJson(..., key) ... }));
```
Up to 40 models in batches of 5, each with a 20s timeout → worst case ~160s, blocking a Telegram callback / webhook.

---

### H7 — Hugging Face provider entries are never classified as free
```ts
for (const entry of asList(info.providers)) {
  ...
  const costTier = costTierOf(entry); // HF provider entries typically have no pricing/is_free
```
HF `/v1/models/{id}` provider entries usually carry no pricing metadata, so `costTierOf` returns 1 for all of them.

**Effect:** the free-model detection is a no-op for the entire Hugging Face path.

---

## LOW

| ID | Description |
|----|-------------|
| L1 | `fetchRetry` does not back off when `retry-after` is missing or ≥ 30 — retries immediately. |
| L2 | `readStore`/`writeStore` are read-modify-write with no lock → concurrent configure/remove can lose updates. |
| L3 | `discoverCatalog` swallows the first error and rethrows only the second — original context lost. |
| L4 | HF route built by raw interpolation of `provider` / `provider_model` without URL-encoding. |
| L5 | `getActiveImageAiProviders` uses `Boolean(p.keyFile)` — true even when the key file does not exist. |
| L6 | Discovery cache key omits the API key; only `clearFreeImageModelCache()` (on configure/remove) invalidates it. |
| L7 | `hasActiveImageAiProvider` can report active even when no usable key exists (same root cause as L5). |

---

## DESIGN RISKS

| ID | Description |
|----|-------------|
| R1 | `configured` candidates are always `costTier: 1` — even Pollinations' `flux` (free) is treated as unknown. If discovery is down, nothing is ever marked free. |
| R2 | No overall deadline for the whole fallback chain — `generateImageWithFallback` can run for minutes across providers × candidates (each up to 120s). |
| R3 | Discovered edit-capable models are excluded from `generateImageWithFallback` (and vice-versa), even when a single model supports both capabilities. |

---

## Summary

| Severity | Count | IDs |
|----------|-------|-----|
| CRITICAL | 5 | C1, C2, C3, C4, C5 |
| HIGH     | 7 | H1–H7 |
| LOW      | 7 | L1–L7 |
| RISK     | 3 | R1–R3 |

Most impactful for the feature: **C2** (accurate free label discarded) and **C3** (large catalogs never discovered) together disable free-model detection for most real-world providers.
