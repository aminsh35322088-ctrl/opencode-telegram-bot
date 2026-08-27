# Custom Providers

The Telegram bot can store OpenAI-compatible providers without adding Railway environment variables for every API.

From Telegram use `/providers`, or open **Settings → API Providers**.

The wizard asks for:

1. Provider name
2. Base URL, e.g. `https://tabitoken.com/v1`
3. API key

The bot calls `GET /models` to discover available models. API keys are stored in a private file under the persistent `/data` volume and are not displayed back. The key message is deleted when Telegram permits it.

OpenCode is restarted after a provider is saved so the generated custom provider config is loaded immediately. Providers use OpenCode's OpenAI-compatible adapter (`@ai-sdk/openai-compatible`) for `/v1/chat/completions` APIs.

## Railway persistence

Keep the Railway Volume mounted at `/data`. Provider metadata and key files live there and survive redeployments.

Never commit provider keys or paste them into GitHub source files.
