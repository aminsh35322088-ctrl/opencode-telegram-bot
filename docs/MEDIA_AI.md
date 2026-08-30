# Media AI

The bot now supports AI image generation and image-to-image editing alongside the OpenCode coding agent.

## Configure Gemini from Custom Providers

No `GEMINI_API_KEY` environment variable is required.

1. Open `/providers` in Telegram.
2. Choose **Add custom provider**.
3. Provider name: `gemini-image`.
4. Base URL: `https://generativelanguage.googleapis.com/v1beta/openai`.
5. Paste your Gemini API key. The bot stores the key in its protected custom-provider key file and never displays it back.
6. Let model discovery finish. Keep `gemini-3.1-flash-image` if it is returned.

Google documents this OpenAI-compatible Gemini endpoint and model listing. The native Gemini image API is used by the media layer for image generation/editing. citeturn1search0turn0search2

## Generate

```text
/image a cinematic cyberpunk city at night, rain, neon lights
```

## Edit

Reply to a Telegram photo with:

```text
/edit remove the background and replace it with a clean blue studio backdrop
```

Or send a photo with `/edit ...` as its caption.

Natural-language editing can handle background replacement, adding/removing elements, style changes, recoloring, and similar generative edits.

## Local media tools

The runtime now includes **FFmpeg** and **ImageMagick** for deterministic operations such as conversion, compression, resizing, cropping, audio extraction, and video transcoding. These are intentionally separate from generative AI so simple media operations stay fast and do not consume image-model quota.

## Model

The default Nano Banana 2 model is `gemini-3.1-flash-image`. Google currently recommends it as the general-purpose Nano Banana image model and documents both generation and image editing. citeturn0search0
