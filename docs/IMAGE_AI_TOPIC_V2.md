# Image AI Topic V2 Architecture

## Goal

Move image generation/editing out of the dedicated Image Chat subsystem and into normal AI Topics, with the current chat/coding model acting as the orchestrator.

## Model selection

- Main Settings owns a global Default Image Model.
- Every normal AI Topic inherits that default by default.
- A Topic may optionally set an Image Model override.
- No hidden automatic image-model fallback is allowed.
- Provider/model resolution remains server-side; model-facing actions do not accept arbitrary provider/model IDs.

Resolution order:

1. Topic Image Model override, when configured and still valid.
2. Main Default Image Model.
3. Explicit unavailable/not-configured error.

## Telegram UI

Normal AI Topic reply keyboard keeps one model entry point rather than adding a permanent second model button.

`🧠 Models` opens a compact hub for:

- Chat / Coding Model
- Image Model

Main Settings → Default Models owns the global Chat/Coding and Image defaults.

Topic Settings → Models owns:

- Topic Chat/Coding Model
- Image Model: Main Default / Topic Override / Reset to Main Default

## Image actions

Canonical model-facing actions remain semantic:

- `media.image.generate`
- `media.image.edit`

They resolve the effective image model internally.

Reference-image priority for edit:

1. Replied image
2. Image attached to the current message
3. Explicit artifact/reference
4. Latest image artifact in the same Topic
5. Ask the user when still ambiguous

## Artifact model

Generated/edited images receive an internal artifact reference and retain Telegram delivery metadata and lineage. Image state is Topic-scoped and must not leak across Topics.

## Migration

The legacy dedicated Image Chat subsystem remains temporarily available only while the V2 path is built and validated. Removal happens after:

1. Default Image Model + Topic override are stable.
2. Normal Topics can call image actions.
3. Reply/current-image resolution is validated.
4. Image artifacts survive normal Topic workflows.
5. Physical Telegram regression checks pass.

Legacy Image Chat profiles should be migrated conservatively where practical. Existing user selections must not silently change to another image model.

## Non-goals for the first phase

- No automatic image-model fallback.
- No provider-specific model-facing actions.
- No separate actions for every edit intent (remove object, relight, recolor, etc.).
- No immediate deletion of legacy Image Chat code before the V2 path is verified.
