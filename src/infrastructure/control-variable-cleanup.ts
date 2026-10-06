import { DEPRECATED_CONTROL_VARIABLES } from "./control-runtime-config.js";

interface Options {
  projectId: string; environmentId: string; serviceId: string;
  names: readonly string[];
  request<T>(document: string, variables: Record<string, unknown>): Promise<T>;
}

/** Fixed removal list only. Caller must first verify this deployment's owned inventory and cluster health. */
export async function cleanupDeprecatedControlVariables(options: Options): Promise<void> {
  const allowed = new Set<string>([...DEPRECATED_CONTROL_VARIABLES, "PORT"]);
  const names = [...new Set(options.names)].filter(name => allowed.has(name)).sort();
  if (names.length === 0) return;
  if (!options.projectId || !options.environmentId || !options.serviceId) throw new Error("Control deployment identity unavailable");
  const variables: Record<string, unknown> = {
    projectId: options.projectId, environmentId: options.environmentId, serviceId: options.serviceId,
  };
  const definitions = names.map((name, index) => { variables[`name${index}`] = name; return `$name${index}:String!`; });
  const removals = names.map((_name, index) => `removed${index}:variableDelete(input:{projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId,name:$name${index}})`);
  const result = await options.request<Record<string, unknown>>(
    `mutation ControlVariableCleanup($projectId:String!,$environmentId:String!,$serviceId:String!,${definitions.join(",")}){${removals.join(" ")}}`, variables,
  );
  if (!result || names.some((_name, index) => result[`removed${index}`] !== true)) throw new Error("Control variable cleanup rejected");
}
