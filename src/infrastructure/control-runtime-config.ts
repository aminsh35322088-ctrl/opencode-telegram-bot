const DEFAULT_REGION = "europe-west4-drams3a";
export const DEPRECATED_CONTROL_VARIABLES = [
  "CONTROL_INFRASTRUCTURE_ENABLED", "CONTROL_PROVISION_WORKERS_ENABLED",
  "CONTROL_DISTRIBUTED_INSPECTION", "CONTROL_WORKSPACE_ID", "CONTROL_PROJECT_ID",
  "CONTROL_ENVIRONMENT_ID", "CONTROL_WORKER_A_PROJECT_ID", "CONTROL_WORKER_A_ENVIRONMENT_ID",
  "CONTROL_WORKER_REGION", "CONTROL_PUBLIC_URL", "CONTROL_WORKER_POOLS",
] as const;

interface ControlRuntimeConfig {
  gatewayEnabled: boolean;
  bootstrapEnabled: boolean;
  projectId: string;
  environmentId: string;
  serviceId: string;
  region: string;
}

/** Accepts sanitized platform metadata, never infrastructure credentials. */
export function resolveControlRuntimeConfig(
  environment: NodeJS.ProcessEnv, infrastructureConfigured: boolean, hasKnownNodes: boolean,
): ControlRuntimeConfig {
  const serviceId = environment.RAILWAY_SERVICE_ID ?? "";
  const region = environment.RAILWAY_REPLICA_REGION;
  return {
    gatewayEnabled: infrastructureConfigured || hasKnownNodes || Boolean(serviceId),
    bootstrapEnabled: infrastructureConfigured && environment.CONTROL_CLUSTER_BOOTSTRAP_ENABLED !== "0",
    projectId: environment.RAILWAY_PROJECT_ID ?? "",
    environmentId: environment.RAILWAY_ENVIRONMENT_ID ?? "",
    serviceId,
    region: region && /^[a-z0-9-]+$/.test(region) ? region : DEFAULT_REGION,
  };
}

export function configureApplicationEnvironment(environment: NodeJS.ProcessEnv, config: ControlRuntimeConfig): void {
  for (const name of DEPRECATED_CONTROL_VARIABLES) delete environment[name];
  environment.CONTROL_CLUSTER_BOOTSTRAP_ENABLED = config.bootstrapEnabled ? "1" : "0";
}
