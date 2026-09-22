export function createRustDeskBridgeClientFromEnv() {
  const client = globalThis.__rustdeskBridgeClient;
  if (!client) throw new Error("missing RustDesk test bridge client");
  return client;
}
