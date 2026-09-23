# SSH through Cloudflare Access

The bot exposes one model-facing `ssh` tool with two transports:

- `direct` for normal reachable SSH servers.
- `cloudflare` for hosts published through Cloudflare Tunnel + Access.

Cloudflare credentials never appear in the tool schema or model output. They are enrolled through **Settings → Integrations → Cloudflare Access** and stored in the bot's persistent integration state. The SSH tool injects the active Service Token only into the child `cloudflared` process.

## Architecture

```text
OpenCode Telegram Bot (Railway)
  ssh + cloudflared client
          |
          v
Cloudflare Access
          |
          v
Cloudflare Tunnel (outbound from remote host)
          |
          v
sshd :22
```

Railway does not need TUN, a Tailnet interface, an inbound port, or a public SSH listener.

## Cloudflare setup

1. Create a Cloudflare Tunnel for the remote server or runner.
2. Publish an SSH hostname and route it to `ssh://localhost:22`.
3. Put the hostname behind a Cloudflare Access self-hosted application.
4. Create a Service Token and allow it with a **Service Auth** policy.
5. In the Telegram bot, open **Settings → Integrations → Add Cloudflare Access** and enter a friendly name, Service Token Client ID, and Client Secret.
6. Ask the bot for `ssh(action="key.public")` and add that public key to the target user's `~/.ssh/authorized_keys`.
7. Use `ssh(action="exec", transport="cloudflare", host="ssh.example.com", user="runner", command="...")`.

For direct SSH, use the same tool with `transport="direct"`.

## Security boundaries

- No SSH private key, Cloudflare Client Secret, or Service Token is accepted as a model argument.
- A bot-owned Ed25519 identity is generated under `/data/.ssh` and survives Railway redeploys.
- Host keys use `StrictHostKeyChecking=accept-new` with a persistent known-hosts file. A changed host key is rejected.
- Upload/download local paths are constrained to the active worktree.
- SCP remote paths are restricted to a conservative safe-character set.
- Commands are non-interactive (`BatchMode=yes`); password prompts are not exposed to the model.

## cloudflared version

The Railway image pins `cloudflared 2026.5.1` and verifies its official SHA-256 checksum at build time. This is intentional: the headless Service Token path in newer 2026.6-era `cloudflared access ssh/tcp` releases has an open regression that can fall back to browser authentication. Revisit the pin only after the upstream issue is confirmed fixed and the headless path is tested.

## Runner side

This PR supplies the bot/client side. A runner or server still needs:

- an SSH server,
- the bot public key in the intended account's `authorized_keys`,
- a Cloudflare Tunnel connected outbound to Cloudflare,
- a stable Access hostname for the session or runner pool.

The runner-side lifecycle can be added independently without changing the bot's SSH API.
