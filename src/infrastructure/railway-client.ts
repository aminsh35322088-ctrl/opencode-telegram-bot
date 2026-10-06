import { childEnvironment } from "../runtime/child-environment.js";

export class InfrastructureRequestError extends Error {
  constructor(readonly category: "schema" | "resource_limit" | "rate_limit" | "transport" | "rejected", readonly status: number, readonly operation: string = "unknown") {
    super("Railway infrastructure request failed");
  }
}

/** Fixed categories only. Server text is inspected privately and never reflected. */
function rejectionCategory(errors: unknown[] | undefined): "schema" | "resource_limit" | "rejected" {
  const messages = (errors ?? []).flatMap(error => typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? [error.message] : []);
  if (messages.some(message => /Cannot query field|Unknown argument|Unknown type|is not defined by type|must have a selection|Variable .* got invalid value|does not exist in .*enum/i.test(message))) return "schema";
  if (messages.some(message => /resource provision limit|limit exceeded|upgrade to provision/i.test(message))) return "resource_limit";
  return "rejected";
}

/** Construct only in the privileged launcher, before importing application modules. */
export function createInfrastructureClient(
  environment: NodeJS.ProcessEnv,
  transport: typeof fetch = fetch,
): {
  readonly configured:boolean;
  request<T>(document: string, variables?: Record<string, unknown>): Promise<T>;
  dispose(): void;
} {
  let credential = environment.RAILWAY_API_TOKEN;
  let retryAt=0;
  const sanitized = childEnvironment(environment);
  for (const name of Object.keys(environment)) {
    if (!(name in sanitized)) delete environment[name];
  }
  // No getter, serialization, diagnostics, IPC, or environment exports the token.
  return {
    configured:typeof credential==="string" && credential.length>0,
    async request<T>(document: string, variables = {}): Promise<T> {
      if (!credential) throw new Error("Railway infrastructure credential unavailable");
      if(Date.now()<retryAt)throw new Error("Railway infrastructure retry deferred");
      const candidate=/^\s*(?:query|mutation)\s+([A-Za-z][A-Za-z0-9]*)\b/.exec(document)?.[1];
      const operation=candidate && /^(?:Worker|ControlGateway|Infrastructure)[A-Za-z0-9]*$/.test(candidate)?candidate:"unknown";
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
        throw new InfrastructureRequestError("transport", 0, operation);
      }
      const body = await response.json().catch(() => null) as { data?: T; errors?: unknown[] } | null;
      if(response.status===429){
        const header=response.headers.get("retry-after");
        const seconds=header?Number(header):NaN;
        const deadline=Number.isFinite(seconds)?Date.now()+Math.max(1000,seconds*1000):header?Date.parse(header):NaN;
        retryAt=Number.isFinite(deadline)?Math.max(Date.now()+1000,deadline):Date.now()+60_000;
      }
      if (!response.ok || !body?.data || body.errors?.length) {
        // Server and transport details can contain credentials; never reflect them.
        throw new InfrastructureRequestError(response.status === 429 ? "rate_limit" : rejectionCategory(body?.errors), response.status, operation);
      }
      return body.data;
    },
    dispose() { credential = undefined; },
  };
}
