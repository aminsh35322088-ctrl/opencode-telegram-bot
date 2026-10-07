import { ControlStore, type AllocationJob } from "./control-store.js";
export interface FleetProvisioner {
  provision(jobId: string): Promise<AllocationJob>;
  destroy(workerId: string, generation: number): Promise<void>;
  inspectDeployment(
    jobId: string,
  ): Promise<{ image: string; deploymentId: string; status: string }>;
}
type RequestApi = <T>(query: string, variables: Record<string, unknown>) => Promise<T>;
type RailwayProject = {
  id: string;
  name: string;
  environments: Connection<{ id: string; name: string }>;
};
type Connection<T> = { edges: Array<{ node: T }>; pageInfo?: { hasNextPage: boolean } };
interface Inventory {
  project: {
    services: Connection<{ id: string; name: string; deletedAt?: string | null }>;
    volumes: Connection<{
      id: string;
      volumeInstances: Connection<{
        serviceId: string | null;
        volumeId: string;
        mountPath: string;
        sizeMB: number;
        state?: string;
        deletedAt?: string | null;
        isPendingDeletion?: boolean;
      }>;
    }>;
  };
  environment: {
    serviceInstances: Connection<{
      serviceId: string;
      domains: { serviceDomains: Array<{ domain: string }> };
      latestDeployment: { id: string; status?: string } | null;
      source?: { image?: string };
    }>;
  };
}
const inventoryQuery =
  "query FleetInventory($projectId:String!,$environmentId:String!){project(id:$projectId){services(first:100){edges{node{id name deletedAt}} pageInfo{hasNextPage}} volumes(first:100){edges{node{id volumeInstances(first:100){edges{node{serviceId volumeId mountPath sizeMB state deletedAt isPendingDeletion}} pageInfo{hasNextPage}}}} pageInfo{hasNextPage}}} environment(id:$environmentId){serviceInstances(first:100){edges{node{serviceId source{image} domains{serviceDomains{domain}} latestDeployment{id status}}} pageInfo{hasNextPage}}}}";

/** Execution-only Railway GraphQL; all operation receipts belong to Cloudflare SQLite. */
export class RailwayFleetDriver implements FleetProvisioner {
  constructor(
    private readonly store: ControlStore,
    private readonly request: RequestApi,
    private readonly options: {
      image: string;
      controlUrl: string;
      bootstrap(job: AllocationJob): Promise<string>;
    },
  ) {
    if (!/^[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}$/.test(options.image))
      throw new Error("immutable_image_required");
    const url = new URL(options.controlUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error("invalid_control_url");
  }
  private async inventory(job: AllocationJob): Promise<Inventory> {
    const value = await this.request<Inventory>(inventoryQuery, {
      projectId: job.projectId,
      environmentId: job.environmentId,
    });
    if (
      value.project.services.pageInfo?.hasNextPage ||
      value.project.volumes.pageInfo?.hasNextPage ||
      value.environment.serviceInstances.pageInfo?.hasNextPage ||
      value.project.volumes.edges.some((v) => v.node.volumeInstances.pageInfo?.hasNextPage)
    )
      throw new Error("inventory_pagination_required");
    value.project.services.edges = value.project.services.edges.filter((s) => !s.node.deletedAt);
    return value;
  }
  async provision(jobId: string): Promise<AllocationJob> {
    let job = this.store.job(jobId);
    if (!job) throw new Error("unknown_job");
    if (job.desiredImage && job.desiredImage !== this.options.image)
      throw new Error("image_contract_mismatch");
    if (!job.desiredImage)
      job = this.store.configureJob(jobId, { desiredImage: this.options.image });
    const worker = this.store.worker(job.workerId);
    if (!worker || worker.generation !== job.generation) throw new Error("stale_generation");
    const backend = this.store.backends().find((b) => b.backendId === job!.backendId);
    if (!backend?.enabled) throw new Error("backend_unavailable");
    const project = this.store.selectProject(jobId);
    if (!project.projectId) {
      const result = await this.request<{ workspace: { projects: Connection<RailwayProject> } }>(
        "query FleetProjects($workspaceId:String!){workspace(workspaceId:$workspaceId){projects{edges{node{id name environments{edges{node{id name}}}}} pageInfo{hasNextPage}}}}",
        { workspaceId: backend.workspaceId },
      );
      if (result.workspace.projects.pageInfo?.hasNextPage)
        throw new Error("inventory_pagination_required");
      const matches = result.workspace.projects.edges.filter(
        (p) => p.node.name === project.projectKey,
      );
      if (matches.length > 1) throw new Error("project_ownership_ambiguous");
      const actual =
        matches[0]?.node ??
        (
          await this.request<{ projectCreate: RailwayProject }>(
            "mutation FleetProjectCreate($input:ProjectCreateInput!){projectCreate(input:$input){id name environments{edges{node{id name}}}}}",
            { input: { name: project.projectKey, workspaceId: backend.workspaceId } },
          )
        ).projectCreate;
      const environment = actual.environments.edges.find((e) => e.node.name === "production")?.node;
      if (!environment) throw new Error("production_environment_missing");
      project.projectId = actual.id;
      project.environmentId = environment.id;
      project.phase = "READY";
      this.store.saveProject(project);
    }
    job = this.store.configureJob(jobId, {
      projectId: project.projectId,
      environmentId: project.environmentId,
    });
    let inventory = await this.inventory(job);
    const name = "topic-node-" + job.workerId;
    const matches = inventory.project.services.edges.filter((s) => s.node.name === name);
    if (matches.length > 1 || (job.serviceId && !matches.some((s) => s.node.id === job!.serviceId)))
      throw new Error("service_ownership_ambiguous");
    if (!job.serviceId) {
      const service =
        matches[0]?.node ??
        (
          await this.request<{ serviceCreate: { id: string } }>(
            "mutation FleetServiceCreate($input:ServiceCreateInput!){serviceCreate(input:$input){id}}",
            { input: { name, projectId: job.projectId, environmentId: job.environmentId } },
          )
        ).serviceCreate;
      job = this.store.configureJob(jobId, { serviceId: service.id });
    }
    if (job.phase === "DEPLOYING" || job.phase === "BOUND") return job;
    if (job.phase === "DEPLOY_SUBMITTED") {
      if (
        inventory.environment.serviceInstances.edges.find(
          (s) => s.node.serviceId === job!.serviceId,
        )?.node.latestDeployment
      )
        return this.store.configureJob(jobId, { phase: "DEPLOYING" });
      throw new Error("deployment_reconciliation_pending");
    }
    const attached = inventory.project.volumes.edges.filter((v) =>
      v.node.volumeInstances.edges.some((i) => i.node.serviceId === job!.serviceId),
    );
    if (attached.length > 1) throw new Error("volume_ownership_ambiguous");
    if (!job.volumeId) {
      if (attached[0])
        job = this.store.configureJob(jobId, {
          volumeId: attached[0].node.id,
          phase: "VOLUME_CREATED",
        });
      else {
        if (job.phase === "VOLUME_CREATING") throw new Error("reconciliation_required");
        this.store.configureJob(jobId, { phase: "VOLUME_CREATING" });
        const volume = await this.request<{ volumeCreate: { id: string } }>(
          "mutation FleetVolumeCreate($input:VolumeCreateInput!){volumeCreate(input:$input){id}}",
          {
            input: {
              projectId: job.projectId,
              environmentId: null,
              serviceId: null,
              mountPath: "/data",
            },
          },
        );
        job = this.store.configureJob(jobId, {
          volumeId: volume.volumeCreate.id,
          phase: "VOLUME_CREATED",
        });
      }
    }
    if (!attached.length) {
      if (job.phase !== "VOLUME_ATTACHING") {
        this.store.configureJob(jobId, { phase: "VOLUME_ATTACHING" });
        await this.mutate(
          'mutation FleetAttachVolume($environmentId:String!,$patch:EnvironmentConfig!){environmentPatchCommit(environmentId:$environmentId,patch:$patch,commitMessage:"Attach dedicated execution volume")}',
          {
            environmentId: job.environmentId,
            patch: {
              volumes: {
                [job.volumeId!]: { isCreated: true, sizeMB: 500, region: backend.region },
              },
              services: {
                [job.serviceId!]: { volumeMounts: { [job.volumeId!]: { mountPath: "/data" } } },
              },
            },
          },
        );
      }
      inventory = await this.inventory(job);
    }
    const mounts = inventory.project.volumes.edges
      .flatMap((v) => v.node.volumeInstances.edges.map((i) => i.node))
      .filter((i) => i.serviceId === job!.serviceId);
    if (
      mounts.length !== 1 ||
      mounts[0]!.volumeId !== job.volumeId ||
      mounts[0]!.mountPath !== "/data" ||
      mounts[0]!.sizeMB !== 500
    )
      throw new Error("volume_activation_pending");
    if (!job.endpoint) {
      let domain = inventory.environment.serviceInstances.edges.find(
        (s) => s.node.serviceId === job!.serviceId,
      )?.node.domains.serviceDomains[0]?.domain;
      if (!domain)
        domain = (
          await this.request<{ serviceDomainCreate: { domain: string } }>(
            "mutation FleetDomain($input:ServiceDomainCreateInput!){serviceDomainCreate(input:$input){domain}}",
            {
              input: {
                serviceId: job.serviceId,
                environmentId: job.environmentId,
                targetPort: 8080,
              },
            },
          )
        ).serviceDomainCreate.domain;
      if (!domain.endsWith(".up.railway.app")) throw new Error("invalid_worker_domain");
      job = this.store.configureJob(jobId, { endpoint: "https://" + domain });
    }
    await this.mutate(
      "mutation FleetLimits($input:ServiceInstanceLimitsUpdateInput!){serviceInstanceLimitsUpdate(input:$input)}",
      {
        input: {
          serviceId: job.serviceId,
          environmentId: job.environmentId,
          memoryGB: 1,
          vCPUs: 2,
        },
      },
    );
    await this.mutate(
      "mutation FleetConfig($environmentId:String!,$serviceId:String!,$input:ServiceInstanceUpdateInput!){serviceInstanceUpdate(environmentId:$environmentId,serviceId:$serviceId,input:$input)}",
      {
        environmentId: job.environmentId,
        serviceId: job.serviceId,
        input: {
          sleepApplication: true,
          numReplicas: 1,
          healthcheckPath: "/health",
          healthcheckTimeout: 300,
          restartPolicyType: "ON_FAILURE",
          restartPolicyMaxRetries: 3,
          multiRegionConfig: { [backend.region]: { numReplicas: 1 } },
          tracingEnabled: false,
          autoInstrumentationEnabled: false,
        },
      },
    );
    const token = await this.options.bootstrap(job);
    await this.mutate(
      "mutation FleetVariables($input:VariableCollectionUpsertInput!){variableCollectionUpsert(input:$input)}",
      {
        input: {
          projectId: job.projectId,
          serviceId: job.serviceId,
          environmentId: job.environmentId,
          replace: true,
          skipDeploys: true,
          variables: { CONTROL_PLANE_URL: this.options.controlUrl, BOOTSTRAP_TOKEN: token },
        },
      },
    );
    const beforeDeploy = await this.inventory(job);
    const previousDeploymentId = beforeDeploy.environment.serviceInstances.edges.find(
      (s) => s.node.serviceId === job.serviceId,
    )?.node.latestDeployment?.id;
    this.store.configureJob(jobId, { phase: "DEPLOY_SUBMITTED", previousDeploymentId });
    const deploymentReceipt = await this.mutate(
      'mutation FleetDeploy($environmentId:String!,$patch:EnvironmentConfig!){environmentPatchCommit(environmentId:$environmentId,patch:$patch,commitMessage:"Deploy immutable execution Worker")}',
      {
        environmentId: job.environmentId,
        patch: { services: { [job.serviceId!]: { source: { image: this.options.image } } } },
      },
    );
    return this.store.configureJob(jobId, {
      phase: "DEPLOYING",
      deploymentReceipt: String(deploymentReceipt),
    });
  }
  private async mutate(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const result = await this.request<Record<string, unknown>>(query, variables);
    const field = /\{([A-Za-z]+)\(/.exec(query)?.[1];
    const receipt = field ? result?.[field] : undefined;
    const valid =
      field === "environmentPatchCommit"
        ? typeof receipt === "string" && receipt.trim().length > 0 && receipt.length <= 256
        : receipt === true;
    if (!valid) throw new Error("railway_mutation_rejected");
    return receipt;
  }
  async inspectDeployment(
    jobId: string,
  ): Promise<{ image: string; deploymentId: string; status: string }> {
    const job = this.store.job(jobId);
    if (!job) throw new Error("unknown_job");
    const inventory = await this.inventory(job);
    const instance = inventory.environment.serviceInstances.edges.find(
      (s) => s.node.serviceId === job.serviceId,
    )?.node;
    if (!instance) throw new Error("worker_unavailable");
    if (instance.source?.image !== job.desiredImage) throw new Error("worker_image_mismatch");
    if (!instance.latestDeployment?.id || instance.latestDeployment.id === job.previousDeploymentId)
      throw new Error("provisioning_pending");
    if (["FAILED", "CRASHED", "REMOVED"].includes(instance.latestDeployment.status ?? ""))
      throw new Error("worker_deployment_failed");
    return {
      image: instance.source!.image!,
      deploymentId: instance.latestDeployment.id,
      status: instance.latestDeployment.status ?? "UNKNOWN",
    };
  }
  async inspectCleanup(workerId: string): Promise<unknown> {
    const worker = this.store.worker(workerId);
    if (!worker?.projectId || !worker.environmentId) throw new Error("unknown_worker_scope");
    const inventory = await this.inventory({
      projectId: worker.projectId,
      environmentId: worker.environmentId,
    } as AllocationJob);
    return {
      services: inventory.project.services.edges
        .filter((s) => s.node.id === worker.serviceId)
        .map((s) => ({ id: s.node.id, deletedAt: s.node.deletedAt })),
      volumes: inventory.project.volumes.edges
        .filter((v) => v.node.id === worker.volumeId)
        .map((v) => ({
          id: v.node.id,
          instances: v.node.volumeInstances.edges.map((i) => ({
            serviceId: i.node.serviceId,
            state: i.node.state,
            deletedAt: i.node.deletedAt,
            isPendingDeletion: i.node.isPendingDeletion,
          })),
        })),
    };
  }
  async destroy(workerId: string, generation: number): Promise<void> {
    const worker = this.store.worker(workerId);
    if (!worker || worker.generation !== generation || worker.state !== "DELETING")
      throw new Error("destructive_fence_required");
    if (!worker.projectId || !worker.environmentId)
      throw new Error("cleanup_reconciliation_required");
    const scope = {
      projectId: worker.projectId,
      environmentId: worker.environmentId,
    } as AllocationJob;
    let inventory = await this.inventory(scope);
    const job = this.store.jobs().find((j) => j.workerId === workerId);
    if (
      !worker.volumeId &&
      (job?.phase === "VOLUME_CREATING" || job?.cleanupPhase === "VOLUME_CREATING")
    )
      throw new Error("cleanup_reconciliation_required");
    const ownedName = "topic-node-" + worker.workerId;
    const matches = inventory.project.services.edges.filter(
      (s) => s.node.id === worker.serviceId || s.node.name === ownedName,
    );
    if (matches.length > 1) throw new Error("cleanup_ownership_mismatch");
    const service = matches[0];
    const serviceId = service?.node.id ?? worker.serviceId;
    if (service) {
      if (service.node.name !== "topic-node-" + worker.workerId)
        throw new Error("cleanup_ownership_mismatch");
      await this.mutate("mutation FleetDestroyService($id:String!){serviceDelete(id:$id)}", {
        id: serviceId,
      });
    }
    inventory = await this.inventory(scope);
    if (
      inventory.project.services.edges.some(
        (s) => s.node.id === serviceId || s.node.name === ownedName,
      )
    )
      throw new Error("cleanup_pending");
    const volume = inventory.project.volumes.edges.find((v) => v.node.id === worker.volumeId);
    if (
      volume?.node.volumeInstances.edges.some(
        (v) => v.node.serviceId && v.node.serviceId !== serviceId,
      )
    )
      throw new Error("cleanup_ownership_mismatch");
    if (volume)
      await this.mutate(
        "mutation FleetDestroyVolume($volumeId:String!){volumeDelete(volumeId:$volumeId)}",
        { volumeId: worker.volumeId },
      );
    inventory = await this.inventory(scope);
    const retained = inventory.project.volumes.edges.find((v) => v.node.id === worker.volumeId);
    if (retained) {
      const instances = retained.node.volumeInstances.edges.map((i) => i.node);
      if (
        !instances.length ||
        !instances.every(
          (i) =>
            i.serviceId === null &&
            i.isPendingDeletion === true &&
            typeof i.deletedAt === "string" &&
            Number.isFinite(Date.parse(i.deletedAt)),
        )
      )
        throw new Error("cleanup_pending");
      // Railway retains administratively deleted, detached volumes for up to 48 hours.
      // Keep the provider purge receipt; this Worker/volume is never reused.
      this.store.recordVolumeDeletion(
        workerId,
        generation,
        instances
          .map((i) => i.deletedAt!)
          .sort()
          .at(-1)!,
      );
    }
  }
}

export function railwayApi(token: string, transport: typeof fetch = fetch): RequestApi {
  return async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    let response: Response;
    try {
      response = await transport("https://backboard.railway.com/graphql/v2", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(15_000),
        redirect: "manual",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const category = /header|character/i.test(message)
        ? "railway_credential_header_invalid"
        : /redirect/i.test(message)
          ? "railway_redirect_rejected"
          : /illegal invocation|receiver/i.test(message)
            ? "railway_transport_invocation_invalid"
            : error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)
              ? "railway_transport_timeout"
              : "railway_transport_error";
      throw new Error(category);
    }
    if (response.status >= 300 && response.status < 400)
      throw new Error("railway_redirect_rejected");
    const result = (await response.json()) as { data?: T; errors?: Array<{ message?: string }> };
    if (!response.ok || result.errors?.length || !result.data) {
      const quota = result.errors?.some((e) =>
        /resource provision limit|limit exceeded|upgrade to provision/i.test(e.message ?? ""),
      );
      throw new Error(
        quota
          ? "railway_quota_exhausted"
          : response.status === 429
            ? "railway_rate_limited"
            : "railway_api_failure",
      );
    }
    return result.data;
  };
}
