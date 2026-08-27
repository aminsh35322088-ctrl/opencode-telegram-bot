# Coding Tools in the Railway image

The runtime image includes a lightweight coding/DevOps toolbelt for OpenCode shell tasks:

- `git` + `git-lfs` for Git operations and large-file repositories
- `gh` for GitHub repositories, issues, pull requests, Actions, releases, and related workflows
- `zip` / `unzip` for archive creation and extraction
- `jq` for JSON processing
- `ripgrep` (`rg`) for fast code search
- `fd` (`fdfind` on Debian) for fast file discovery
- `tree` for directory inspection
- `file` for file-type detection
- `rsync` for efficient file synchronization
- `curl` / `wget` for HTTP resources
- `openssh-client` for SSH/Git-over-SSH workflows
- `procps` for process inspection (`ps`, etc.)

These are installed in the Docker runtime image, not as Railway environment variables, so the coding agent can use them directly through its shell/tooling.
