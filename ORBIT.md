# Orbit / Flux deployment

This repository includes an Orbit-specific Nixpacks configuration for running the Telegram bot and its local OpenCode server as a long-running Flux container. Railway keeps using the existing `Dockerfile` and `railway-entrypoint.sh`; Orbit uses `nixpacks.toml` and `orbit-entrypoint.sh`.

## Orbit Free plan

Orbit currently advertises a Free plan with 0.5 vCPU, 1 GB RAM, 5 GB storage and one instance. The free app is renewed while it is the only Git app on the account/network. The bot is a background/persistent process, so the Orbit entrypoint also exposes a minimal HTTP health endpoint on the `APP_PORT` selected in the Orbit wizard.

## Deploy

1. In Orbit, create a new app from this public GitHub repository and select the `main` branch.
2. Choose the Free plan for the first compatibility test.
3. Pick an application port in the Orbit wizard. The bot does not expose OpenCode publicly; this port serves only a small health response. Orbit injects the selected value as `APP_PORT`.
4. Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_USER_ID` as runtime environment variables/secrets.
5. Leave the Install, Build and Start command overrides blank so Orbit uses `nixpacks.toml` from the repository.
6. Deploy and check the build/runtime logs for `[orbit] Runtime bootstrap starting`, the OpenCode CLI version, and `Health endpoint listening`.

The Nixpacks build installs the same core runtime toolchain used by the Railway image: OpenCode, Git/Git LFS, GitHub CLI, Railway CLI, Python, FFmpeg/ImageMagick and Playwright Chromium. This keeps coding, repository, media and browser workflows available on Orbit instead of deploying a reduced bot.

## State and persistence warning

The Orbit entrypoint stores bot/OpenCode state under `/app/.orbit-state` by default. You can override this with `ORBIT_STATE_DIR` if a durable mount is available.

Do **not** treat the Free plan's local filesystem as a production-grade replicated datastore. Orbit's Deploy-with-Git documentation describes Git deployments as stateless and warns that local state can be lost on redeploy. Flux also distinguishes a soft reinstall, which preserves persistent data, from a hard reinstall, which wipes it. The Free plan has one instance, so it does not provide the replicated persistent-folder feature exposed by Orbit for multi-instance plans.

For testing and low-risk use, the local state directory is useful. For production use where losing sessions, credentials or workspace state is unacceptable, keep Railway's persistent `/data` volume as the source of truth or move persistent state to an external durable service before relying on Orbit alone.

## Orbit-specific environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ORBIT_STATE_DIR` | `/app/.orbit-state` | Bot/OpenCode writable state root |
| `ORBIT_APP_ROOT` | current working directory | Override only if Orbit changes the checkout/start directory |
| `APP_PORT` | supplied by Orbit | Minimal HTTP health endpoint; required by Orbit |

All normal bot environment variables remain supported. Never commit Telegram tokens, GitHub tokens, provider API keys, or other credentials to the repository.
