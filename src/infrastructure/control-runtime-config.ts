const DEFAULT_REGION = "europe-west4-drams3a";
export const DEPRECATED_CONTROL_VARIABLES = [
  "CONTROL_INFRASTRUCTURE_ENABLED", "CONTROL_PROVISION_WORKERS_ENABLED",
  "CONTROL_DISTRIBUTED_INSPECTION", "CONTROL_WORKSPACE_ID", "CONTROL_PROJECT_ID",
  "CONTROL_ENVIRONMENT_ID", "CONTROL_WORKER_A_PROJECT_ID", "CONTROL_WORKER_A_ENVIRONMENT_ID",
  "CONTROL_WORKER_REGION", "CONTROL_PUBLIC_URL", "CONTROL_WORKER_POOLS",
  "CONTROL_CLUSTER_BOOTSTRAP_ENABLED", "TOPIC_NODE_CREATION_ENABLED",
  "WORKER_POOL_POLICY", "WORKER_WARM_CAPACITY", "TELEGRAM_ALLOWED_USER_ID",
] as const;

interface ControlRuntimeConfig {
  gatewayEnabled: boolean;
  projectId: string;
  environmentId: string;
  serviceId: string;
  region: string;
}

/** Accepts sanitized Railway platform metadata, never infrastructure credentials or Worker policy. */
export function resolveControlRuntimeConfig(
  environment: NodeJS.ProcessEnv, infrastructureConfigured: boolean, hasKnownNodes: boolean,
): ControlRuntimeConfig {
  const serviceId = environment.RAILWAY_SERVICE_ID ?? "";
  const region = environment.RAILWAY_REPLICA_REGION;
  return {
    gatewayEnabled: infrastructureConfigured || hasKnownNodes || Boolean(serviceId),
    projectId: environment.RAILWAY_PROJECT_ID ?? "",
    environmentId: environment.RAILWAY_ENVIRONMENT_ID ?? "",
    serviceId,
    region: region && /^[a-z0-9-]+$/.test(region) ? region : DEFAULT_REGION,
  };
}

export function configureApplicationEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const name of DEPRECATED_CONTROL_VARIABLES) delete environment[name];
}
