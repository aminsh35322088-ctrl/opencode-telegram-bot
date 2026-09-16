# Dedicated Image Chats

Main has **New Chat** and **New Image Chat**. Coding and image conversations have separate Topic bindings and execution paths. An image request never creates, interrupts or switches an OpenCode session.

## Setup

Open **Settings → AI Providers**:

- **Chat & Coding** manages custom OpenAI-compatible conversation providers. Use **Default Model** to choose the model for new coding Topics. Existing native OpenCode providers stay in that catalog.
- **Image** configures the profile copied into each new Image Chat. Choose either a native Gemini image model, or a vision conversation connection plus an image generator/editor.
- **Transcription** manages Groq and custom transcription connections. For a custom connection, open its details and choose its transcription model.

Video AI configuration and role selection are removed. Legacy video provider records are ignored, never converted into coding providers. Video *input* metadata on chat models and ordinary file processing remain supported.

The model catalog excludes advertised image/audio/video output models from coding, favorites, recent entries, search, and selection. Providers that omit modality metadata still rely on their explicitly configured Chat & Coding role; unknown metadata is not proof of image or speech support. Image tool conversations require advertised image input or an explicit attachment capability.

Free Model Detection and its existing price colors are unchanged. Experimental remains immediately above Advanced.

## Image profiles

**Native Gemini:** enter the exact model ID and Gemini API key. Setup checks key/model access through `models.get` and requires `generateContent`. It does not generate a test image or guarantee image output from an arbitrary text model. Choose a Gemini model supporting text, image generation and conversational editing. The adapter uses the native `generateContent` protocol and preserves returned part order and opaque thought signatures. It does not use the separate Interactions API.

**Conversation + image tool:** choose a configured vision chat connection, its exact model ID, and a generator with both generation and editing. Any compatible Custom API can provide the conversation model. Existing Cloudflare Workers AI and Custom image APIs provide the actual generation/edit operation. A custom image API must support `/images/generations`, `/images/edits` and Base64 image responses. The planner's valid structured decision determines discussion/generation/editing; malformed output asks for clarification and cannot trigger an image call.

**Auto mode:** only conversation models whose IDs explicitly contain a `:free` variant marker and that advertise image input are considered. Known model families are ranked in the existing GPT → Gemini → DeepSeek → Qwen → GLM → Mistral → Llama order. This keeps automatic selection provider-agnostic without assuming an arbitrary account or gateway is free.

A Topic pins its mode, connection IDs, endpoints, conversation model, image model and edit model. Credential rotation for the same connection is supported. Removing a connection or changing a pinned endpoint/model produces an actionable error; the bot never silently changes engine or retries an ambiguous generation POST. Changing the default affects only new Topics. **New design with current default** explicitly resets an existing Topic and adopts the updated profile.

## Use

1. Press **New Image Chat** in Main.
2. Send an idea or discuss a design. Ask explicitly when you want an image generated.
3. Send a photo or PNG/JPEG/WebP file to edit. A photo without instructions is remembered as a reference and does not start inference.
4. Continue with instructions such as “make the background blue.” Reply to an older image to branch from that version.
5. **New design** clears the conversation context. **Stop** cancels running and queued requests for that Topic and retains its last completed image. **Delete** confirms before removing the Topic and binding.

Image Topics accept text and images. Native mode accepts albums of up to four references; the existing image tool APIs use one reference per edit, so multi-reference requests in tool mode ask for a single image instead of silently dropping references. Generated images are delivered as documents to retain the original pixels for later edits. Topics remain accessible through Telegram's Topic list.

The old Image AI toggle, generate/edit action menu, and coding-topic media routes are removed. Old `/image`, `/edit` and inline buttons in coding Topics direct the user to New Image Chat. Coding photo captions now go to the selected coding model for image understanding. Image Topic settings callbacks never enter coding model selection.

## State and resource bounds

- Durable state is keyed by **chat ID + Topic ID**, with an explicit `kind: image`, profile, revision, text/parts, Telegram file IDs and up to 100 handled message IDs. No Base64 image buffers are persisted.
- State mutations run inside the serialized app-state writer; revisions prevent stopped, reset or deleted Topics from being revived by late completions. Reads wait for pending writes and primary-file replacement is atomic.
- At most **100 Image Topics**, **12 retained turns** (user/model entries), **128 KiB of conversation metadata per Topic**, and **24 hours of idle context**. Limits tell the user to start a new design. Expired context starts from the retained image reference.
- At most **3 outstanding requests per Topic**, **20 outstanding globally**, **2 active globally**. Each active request has a **180-second deadline**. Cancellation is checked before and after delivery and before persisting results; partial Telegram output is removed on delivery failure or cancellation when Telegram permits deletion.
- Images are downloaded from Telegram only for processing: **8 MiB per image**, **24 MiB total reference bytes per operation**, and bounded provider JSON responses. Those bytes live temporarily in process memory, not the Railway volume. Actual total RAM also includes JSON/Base64 copies and the existing bot/OpenCode runtime.
- No generation retry or provider fallback happens automatically. After a restart, interrupted requests are not replayed. Resend the request explicitly if needed.
- History reset includes Image Topics and keeps their bindings if Telegram deletion fails. Factory reset stops image operations before clearing persistent configuration.

Telegram references are not an independent backup. If a referenced file cannot be downloaded, the user must send it again. No live provider or production Telegram calls are part of the unit/integration validation.

Protocol references: [Gemini generateContent API](https://ai.google.dev/api/generate-content), [Gemini image generation](https://ai.google.dev/gemini-api/docs/image-generation), [thought signatures](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking/thought-signatures), [Telegram Bot API](https://core.telegram.org/bots/api).