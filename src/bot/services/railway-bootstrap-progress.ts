import {t} from "../../i18n/index.js";

export interface RailwayBootstrapBindingLike {
  slot?: number;
  projectId?: string;
  serviceId?: string;
  volumeId?: string;
  status?: string;
}

export function isRailwayBootstrapResourceLimit(error:unknown):boolean {
  return error instanceof Error && /^Infrastructure operation failed \(resource_limit, HTTP \d+\)/u.test(error.message);
}

export function canContinueRailwayBootstrapWithLimitedResources(progress:RailwayBootstrapProgress,error:unknown):boolean {
  return isRailwayBootstrapResourceLimit(error) && progress.projects>0 && progress.healthy>0 && progress.workers>=progress.healthy && progress.volumes>=progress.healthy;
}

export function renderRailwayBootstrapLimit(progress:RailwayBootstrapProgress):string {
  return renderRailwayBootstrapProgress(progress)+"\n\n"+t("railway.setup.free_limit",{healthy:progress.healthy,target:progress.workersTarget});
}

export interface RailwayBootstrapProgress {
  projects: number;
  projectsTarget: number;
  workers: number;
  workersTarget: number;
  volumes: number;
  volumesTarget: number;
  healthy: number;
  healthyTarget: number;
  complete: boolean;
}

export function summarizeRailwayBootstrap(
  bindings: readonly RailwayBootstrapBindingLike[],
  projectCount: number,
  workerTarget: number,
): RailwayBootstrapProgress {
  const target = Number.isSafeInteger(workerTarget) && workerTarget > 0 ? workerTarget : 5;
  const active = bindings.filter((binding) =>
    binding.status !== "retired" && (binding.slot === undefined || binding.slot <= target),
  );
  const projectsTarget = 1;
  const projects = Math.min(projectsTarget, Math.max(0, Math.trunc(projectCount)));
  const workers = Math.min(target, active.filter((binding) => Boolean(binding.serviceId)).length);
  const volumes = Math.min(target, active.filter((binding) => Boolean(binding.volumeId)).length);
  const healthy = Math.min(target, active.filter((binding) => binding.status === "available" && Boolean(binding.serviceId) && Boolean(binding.volumeId)).length);
  return {
    projects,
    projectsTarget,
    workers,
    workersTarget: target,
    volumes,
    volumesTarget: target,
    healthy,
    healthyTarget: target,
    complete: projects >= projectsTarget && workers >= target && volumes >= target && healthy >= target,
  };
}

function marker(value: number, target: number): string {
  if (value >= target) return "✅";
  return value > 0 ? "⏳" : "○";
}

export function renderRailwayBootstrapProgress(progress: RailwayBootstrapProgress): string {
  const title = progress.complete ? "🚂 <b>Railway Ready</b>" : "🚂 <b>Setting up Railway</b>";
  return [
    title,
    "",
    "✅ Token authenticated",
    "✅ Account verified",
    `${marker(progress.projects, progress.projectsTarget)} Projects created ${progress.projects}/${progress.projectsTarget}`,
    `${marker(progress.workers, progress.workersTarget)} Workers created ${progress.workers}/${progress.workersTarget}`,
    `${marker(progress.volumes, progress.volumesTarget)} Volumes attached ${progress.volumes}/${progress.volumesTarget}`,
    `${marker(progress.healthy, progress.healthyTarget)} Deploy &amp; health checks ${progress.healthy}/${progress.healthyTarget}`,
  ].join("\n");
}
