# Control Plane capabilities

Cloudflare owns encrypted integration material and account metadata. Core and Topic Workers consume narrowly authorized capabilities; they do not own account credentials. Provider, GitHub, Tailscale, and authenticated remote MCP references share the same broker and registry. An independent mock database integration exercises the registry without built-in GitHub or Tailscale paths.

The registry declares credential type, capabilities, required scopes, Core adapter, persistence, and process lifecycle. Account configuration lives in General. Active account selection changes the canonical credential reference, without exporting Worker environment variables.

Signed Worker requests use `credential.acquire`, `credential.validate`, `credential.release`, and secretless `capability.authorize`. Cloudflare checks current Worker, active Topic, generation, signing identity, session, integration, credential reference, capability, and scopes. Provider delivery additionally requires an active admitted run and its approved proxy configuration. Worker requests cannot enumerate the vault. Authorization is checked again after asynchronous delivery and signing.

Ciphertext is bound to a unique credential ID. Snapshots contain references and metadata, not material. Leases expire within 60 seconds and live in an indexed dedicated table. Rotation removes the displaced reference; removal, Topic replacement, or generation fencing invalidates subsequent validation. Core must poll or revalidate leases and cancel ongoing transport when authorization disappears; a lease cannot undo bytes already sent upstream.

GitHub delivery verifies the selected repository and its Git upload/receive transport. Account `/user` validation alone is insufficient. Fine-grained token errors distinguish credential failure, unavailable repositories, and missing read/write permission without echoing upstream response bodies.

Tailscale account configuration accepts management API tokens (`tskey-api`), which differ from device enrollment keys (`tskey-auth`). Cloudflare mints a single-use, five-minute enrollment key tagged `tag:opencode-bot`; the management token never goes to the Worker. Core governs the daemon and SSH. Each Topic Worker persists its own node identity on its own `/data/tailscale` volume. Removing the account revokes credential access; it does not imply deleting an existing node identity.

Current remote MCP delivery supports a protected JSON header reference. Extending the registry and delivery adapter does not add another secret store. Local MCP, extension, or action consumers must acquire through the same broker, inject only into their governed process, and release during cleanup. Raw-secret access must never become a model tool.

Legacy encrypted provider/account rows remain only for controlled migration and compatibility with currently deployed Workers. The old provider request operation delegates to the generic broker. Remove migration paths only after the exact released Worker image has passed production qualification.

General reset fences and cleans Workers before atomically clearing configuration references, account metadata, encrypted credential rows, and leases. UI validation errors use fixed recovery notices and never reflect submitted configuration or exception material. Invalid configuration forms remain available for correction.

Production qualification includes encrypted account migration, real Git operations, Tailscale enrollment and SSH, credential rotation/revocation, Worker replacement, sleep/wake, identity persistence, process cleanup, and resource measurements. Unit tests alone do not establish these outcomes.
