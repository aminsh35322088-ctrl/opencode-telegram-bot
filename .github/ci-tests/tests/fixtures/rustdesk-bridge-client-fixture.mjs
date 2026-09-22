export function createRustDeskBridgeClientFromEnv() {
  const client = globalThis.__rustdeskBridgeClient;
  if (!client) throw new Error("missing RustDesk test bridge client");
  return client;
}

export async function consumeRustDeskPermissionGrantHandoff(request) {
  const consume = globalThis.__rustdeskConsumePermissionHandoff;
  if (!consume) throw new Error("missing RustDesk permission handoff test consumer");
  return consume(request);
}

export async function discardRustDeskPermissionGrantHandoffsForSession(input) {
  const cleanup = globalThis.__rustdeskDiscardSessionHandoffs;
  if (cleanup) return cleanup(input);
  return 0;
}
