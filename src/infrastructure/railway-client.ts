import { childEnvironment } from "../runtime/child-environment.js";

/** Construct only in the privileged launcher, before importing application modules. */
export function createInfrastructureClient(
  environment: NodeJS.ProcessEnv,
  transport: typeof fetch = fetch,
): {
  request<T>(document: string, variables?: Record<string, unknown>): Promise<T>;
  dispose(): void;
} {
  let credential = environment.RAILWAY_API_TOKEN;
  const sanitized = childEnvironment(environment);
  for (const name of Object.keys(environment)) {
    if (!(name in sanitized)) delete environment[name];
  }
  // No getter, serialization, diagnostics, IPC, or environment exports the token.
  return {
    async request<T>(document: string, variables = {}): Promise<T> {
      if (!credential) throw new Error("Railway infrastructure credential unavailable");
      let response: Response;
      try {
        response = await transport("https://backboard.railway.com/graphql/v2", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` },
          body: JSON.stringify({ query: document, variables }),
          signal: AbortSignal.timeout(15_000),
          redirect: "error",
        });
      } catch {
        throw new Error("Railway infrastructure request failed");
      }
      const body = await response.json().catch(() => null) as { data?: T; errors?: unknown[] } | null;
      if (!response.ok || !body?.data || body.errors?.length) {
        // Server and transport details can contain credentials; never reflect them.
        throw new Error("Railway infrastructure request failed");
      }
      return body.data;
    },
    dispose() { credential = undefined; },
  };
}
