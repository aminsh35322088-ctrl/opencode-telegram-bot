# Direct SSH client

The bot includes a direct, key-only SSH client for servers that are reachable from Railway over normal TCP/IP.

## First-time setup

1. Ask the agent to run `ssh.key.public`.
2. Copy the returned public key into the target account's `~/.ssh/authorized_keys`.
3. Make sure the SSH server is reachable from Railway and note its hostname/IP, username, and port.
4. The agent can then use `ssh.exec`, `ssh.read`, `ssh.write`, `ssh.upload`, and `ssh.download`.

No SSH password or private key is entered into Telegram or exposed to the model.

## Actions

- `ssh.status` — inspect local OpenSSH/identity readiness.
- `ssh.key.ensure` — create the persistent bot-owned Ed25519 identity if missing.
- `ssh.key.public` — return only the public key and SHA-256 fingerprint.
- `ssh.exec` — execute a non-interactive remote command.
- `ssh.read` — read a remote text file.
- `ssh.write` — write a remote text file with restrictive default permissions.
- `ssh.upload` — upload a regular file from the active worktree.
- `ssh.download` — download a remote file into the active worktree.

## Security model

The private key is stored under `/data/.ssh/opencode_ed25519` on the persistent Railway volume with mode 0600. The tool forces `BatchMode=yes` and `IdentitiesOnly=yes`, so password/passphrase prompts and unrelated agent keys are not used.

Host verification uses `StrictHostKeyChecking=accept-new` with a persistent `known_hosts` file. OpenSSH therefore accepts a host the first time but rejects a changed host key on later connections. See the OpenSSH `ssh_config(5)` manual: https://man.openbsd.org/ssh_config.

Local upload/download paths are restricted to the active worktree. Remote transfer paths use a conservative character allowlist. Remote command/file operations have a hard maximum timeout of 120 seconds.

This tool is intentionally direct-only and has no remote-desktop or tunnel transport layer.
