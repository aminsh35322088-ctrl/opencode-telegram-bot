const ENDPOINT = "https://backboard.railway.com/graphql/v2";
const TIMEOUT_MS = 15_000;

export interface RailwayWorkspaceChoice { id: string; name: string; }
export type RailwayCredentialValidation =
  | { valid: true; tokenType: "account" | "workspace"; subjectName?: string; workspaces: RailwayWorkspaceChoice[] }
  | { valid: false; reason: "invalid" | "unauthorized" | "network" | "scope" };

interface Options { token: string; controlProjectId: string; transport?: typeof fetch; }
interface GraphqlBody<T> { data?: T; errors?: Array<{ message?: string }>; }

function normalizeToken(value: string): string {
  const token = value.trim();
  if (!token || token.length > 4096 || /[\r\n\u0000]/u.test(token)) throw new Error("Invalid Railway credential");
  return token;
}
async function request<T>(token: string, query: string, variables: Record<string, unknown>, transport: typeof fetch): Promise<{response:Response;body:GraphqlBody<T>|null}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await transport(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
      redirect: "error",
    });
    const body = await response.json().catch(() => null) as GraphqlBody<T> | null;
    return { response, body };
  } finally { clearTimeout(timer); }
}
function unauthorized(response: Response, body: GraphqlBody<unknown> | null): boolean {
  if (response.status === 401 || response.status === 403) return true;
  return Boolean(body?.errors?.some(error => /not authorized|unauthorized|forbidden|permission denied/i.test(error.message ?? "")));
}
function cleanWorkspaces(value: unknown): RailwayWorkspaceChoice[] {
  if (!Array.isArray(value)) return [];
  const result: RailwayWorkspaceChoice[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const id = (item as {id?:unknown}).id;
    const name = (item as {name?:unknown}).name;
    if (typeof id !== "string" || !id || id.length > 256 || typeof name !== "string" || !name.trim() || name.length > 256 || seen.has(id)) continue;
    seen.add(id); result.push({ id, name: name.trim() });
  }
  return result;
}

export async function validateRailwayInfrastructureCredential(options: Options): Promise<RailwayCredentialValidation> {
  let token: string;
  try { token = normalizeToken(options.token); } catch { return { valid: false, reason: "invalid" }; }
  if (!options.controlProjectId || options.controlProjectId.length > 256) return { valid: false, reason: "scope" };
  const transport = options.transport ?? fetch;
  try {
    const account = await request<{me?:{id?:string;name?:string|null;email?:string|null;workspaces?:unknown}}>(
      token,
      "query InfrastructureCredentialAccount { me { id name email workspaces { id name } } }",
      {}, transport,
    );
    const accountIdentity = account.response.ok && account.body?.data?.me?.id ? account.body.data.me : undefined;
    const accountWorkspaces = accountIdentity ? cleanWorkspaces(accountIdentity.workspaces) : [];

    // Every accepted token must be able to inspect the deployed Control project.
    // This is a read-only authorization check and avoids discovering missing scope
    // only after the first Worker mutation.
    const scope = await request<{project?:{workspaceId?:string|null}|null}>(
      token,
      "query InfrastructureCredentialWorkspaceScope($projectId:String!){ project(id:$projectId){ workspaceId } }",
      { projectId: options.controlProjectId }, transport,
    );
    const controlWorkspaceId = scope.body?.data?.project?.workspaceId;

    if (accountIdentity) {
      if (!scope.response.ok || typeof controlWorkspaceId !== "string" || !controlWorkspaceId || !accountWorkspaces.some(item => item.id === controlWorkspaceId)) {
        return { valid: false, reason: "scope" };
      }
      return {
        valid: true,
        tokenType: "account",
        ...(accountIdentity.name ? { subjectName: accountIdentity.name } : {}),
        workspaces: accountWorkspaces,
      };
    }

    if (scope.response.ok && typeof controlWorkspaceId === "string" && controlWorkspaceId) {
      const workspace = await request<{workspace?:{id?:string;name?:string}|null}>(
        token,
        "query InfrastructureCredentialWorkspace($workspaceId:String!){ workspace(workspaceId:$workspaceId){ id name } }",
        { workspaceId: controlWorkspaceId }, transport,
      );
      const item = workspace.body?.data?.workspace;
      if (workspace.response.ok && item?.id === controlWorkspaceId && typeof item.name === "string" && item.name.trim()) {
        return { valid: true, tokenType: "workspace", workspaces: [{ id: controlWorkspaceId, name: item.name.trim() }] };
      }
    }
    if (unauthorized(account.response, account.body) && unauthorized(scope.response, scope.body)) return { valid: false, reason: "unauthorized" };
    return { valid: false, reason: "scope" };
  } catch { return { valid: false, reason: "network" }; }
}
