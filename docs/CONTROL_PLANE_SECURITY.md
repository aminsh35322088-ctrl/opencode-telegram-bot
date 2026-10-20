# Infrastructure credential boundary

Railway starts `dist/infrastructure/launcher.js` as the privileged infrastructure
identity. A legacy startup credential, when present, is captured in a private
closure and removed from the child environment. The preferred first-run path
accepts a Railway Account or Workspace token over the inherited parent/child IPC,
validates it in the privileged launcher, and persists it encrypted under the
root-only `/data/.infrastructure` directory. The credential is never returned,
logged, placed in model state, or forwarded to Workers.

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

The application has only a narrow inherited IPC setup surface: read setup status,
submit one transient candidate credential, and select one validated workspace.
There is no generic GraphQL proxy or credential getter. Bound Topic Workers may
request a fixed read-only Railway tool surface (workspace/projects, project and
service metadata, recent deployment status, and bounded deployment logs). The
Control Plane validates each project against its selected workspace, each service
and environment against that project, and each log request against a deployment
belonging to that service. The model cannot submit GraphQL documents or mutations;
secret variable values are never returned. The tool request travels over the
existing signed node protocol and privileged launcher IPC. Infrastructure lifecycle
requests remain separately allow-listed (`provision`, `retire`, `reconcile`). The
public HTTP gateway exposes only health and the signed node protocol.

Worker allocation is request-driven. Definitive Railway quota exhaustion may
create the next managed `opencode-topic-NN` project in the selected workspace;
transport ambiguity never authorizes blind resource recreation. Each Worker gets
only its node identity secret and Control URL, never the Railway or Telegram
credential.

Verification uses synthetic credentials only, the governed-process regression
tests, and a container boundary check for UID, immutable code, `/proc` isolation,
symlink writes, startup failure, and signal termination. The existing CI workflow
discovers the new `tests/core-infrastructure-*.test.ts` files; no workflow is added.

Rollback: reconnect the Bot Railway service to its previous pinned GitHub commit
and deploy. No durable state migration or volume deletion is performed by this
change. A rollback restores the old token-inheritance behavior, so it must be
treated as a temporary recovery action rather than a security-equivalent release.
