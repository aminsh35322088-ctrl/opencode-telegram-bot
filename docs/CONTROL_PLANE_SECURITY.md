# Infrastructure credential boundary

Railway starts `dist/infrastructure/launcher.js` as the privileged infrastructure
identity. Before importing application dependencies, it captures the account
credential in a private closure and removes all Railway token variants from the
environment. It never returns, serializes, logs, or forwards the credential.

The launcher prepares ownership of the `/data` mount root only, then starts
maintenance and application bootstrap as UID/GID 1000. Both scripts reject other
UIDs. All application code and dependencies in `/app` are root-owned and not
writable by the application. Workspace links are built into the immutable image.
No application-controlled SQLite initialization file, symlink, Git hook, config,
or startup probe executes as the credential-owning identity.

The existing process budget also strips Railway token variants from every
`spawn`, `execFile`, and shell `exec` environment, including explicit overrides.
The application and Core cannot read the privileged launcher's `/proc` environment
under the Linux identity boundary. A compromise of the container's privileged
identity is outside this boundary; an ordinary application process must never be
given that identity or an escalation capability.

The captured client currently has no application IPC or public endpoint. It makes
no idle requests. Adding an allocator requires a narrow, authenticated operation
interface and must not expose a generic GraphQL proxy or credential getter.

This is a prerequisite for the distributed Topic migration. It does not ship
remote Topic nodes, canonical revision/snapshot sync, approval receipts, or a
remote cutover. The local Core remains active until those paths pass deployment
and end-to-end tests.

Verification uses synthetic credentials only, the governed-process regression
tests, and a container boundary check for UID, immutable code, `/proc` isolation,
symlink writes, startup failure, and signal termination. The existing CI workflow
discovers the new `tests/core-infrastructure-*.test.ts` files; no workflow is added.

Rollback: reconnect the Bot Railway service to its previous pinned GitHub commit
and deploy. No durable state migration or volume deletion is performed by this
change. A rollback restores the old token-inheritance behavior, so it must be
treated as a temporary recovery action rather than a security-equivalent release.
