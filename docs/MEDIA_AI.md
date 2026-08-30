# Media AI

The bot can optionally provide AI image generation and image-to-image editing alongside the OpenCode coding agent.

## Configuration

Set:

```env
GEMINI_API_KEY=your-key
GEMINI_IMAGE_MODEL=gemini-3.1-flash-image
```

`GEMINI_IMAGE_MODEL` is optional. The default is Nano Banana 2 (`gemini-3.1-flash-image`).

## Generate an image

```text
/image a cinematic cyberpunk city at night, rain, neon lights, 16:9
```

## Edit an image

Reply to a Telegram photo with:

```text
/edit remove the background and replace it with a clean blue studio backdrop
```

Or send a photo with the same `/edit ...` instruction as its caption.

The same editing flow can handle natural-language requests such as removing or adding elements, changing styles, changing colors, and replacing backgrounds.

## Architecture

The media layer is deliberately separate from the OpenCode model. The Telegram bot calls a provider abstraction so image generation/editing can evolve independently from coding models.

The current provider uses Google's Gemini native image API. Exact deterministic operations such as compression, resizing, or video transcoding should remain separate local media tools rather than being forced through a generative model.
