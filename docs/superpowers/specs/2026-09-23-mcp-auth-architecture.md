# MCP Authentication Architecture Spec

## User experience
MCP setup defaults to automatic detection. A server that connects without authentication requires no additional UI. A server reporting OAuth authentication shows a direct Sign In action. A server requiring client registration shows a pre-registered OAuth client setup. Failed remote servers expose an Authentication menu for token/API-key/custom-header fallback.

All MCP setup and authentication flows edit the canonical General panel. User credential messages are deleted immediately after receipt. Navigation is consistent: Back moves one logical level up, Cancel exits the current auth flow back to server detail, and Home uses the existing main:home callback.

## Authentication modes
1. No auth / Auto Detect.
2. Native OAuth through OpenCode, including PKCE/token refresh.
3. Bearer token.
4. API key with a validated header name; default X-API-Key.
5. Custom HTTP header with a validated header name.
6. Pre-registered OAuth client ID plus optional client secret and scope.

## Secret boundary
No new Railway variables are created. Raw secrets are not stored in OpenCode project config or passed through model-facing actions. Bot persistence stores encrypted credential payloads only. Encryption derives its key from the existing Telegram bot token, which the host already strips from the OpenCode agent environment. If decryption fails after token rotation or tampering, the credential is treated as unavailable and the UI asks for reconfiguration.

For authenticated remote MCPs, the bot reconstructs the connection using OpenCode's dynamic in-memory MCP add API. OpenCode receives the secret only in process memory for the MCP connection. On OpenCode restart, the bot restores these dynamic definitions from its encrypted credential store.

## Visibility
Models may see MCP connection status and non-secret auth mode. Models must never receive API keys, bearer tokens, custom header values, OAuth client secrets, authorization codes, access tokens, or refresh tokens through the bot action surface.

## Validation
Remote URLs must be absolute HTTP(S). Custom header names must be RFC token-safe and values must reject CR/LF. OAuth callback state validation remains mandatory. Credential input messages must be deleted even when validation fails.
