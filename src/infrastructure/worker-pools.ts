import type {WorkerPool} from './node-provisioner.js';
interface Connection<T>{edges:Array<{node:T}>;pageInfo:{hasNextPage:boolean}}
interface Project{id:string;name:string;environments:Connection<{id:string;name:string}>}
interface Options{request<T>(document:string,variables:Record<string,unknown>):Promise<T>;workspaceId:string;controlProjectId:string;controlEnvironmentId:string;workerProjectId:string;workerEnvironmentId:string;region:string;onStage?:(stage:'inventory'|'verify')=>void}
/** Verify existing projects only. Provisioning must never create a third project. */
export async function resolveWorkerPools(options:Options):Promise<[WorkerPool,WorkerPool]>{
 options.onStage?.('inventory');
 const inventory=await options.request<{workspace:{id:string;projects:Connection<Project>}}>('query WorkerPools($workspaceId:String!){workspace(workspaceId:$workspaceId){id projects(first:100){pageInfo{hasNextPage} edges{node{id name environments(first:100){pageInfo{hasNextPage} edges{node{id name}}}}}}}}',{workspaceId:options.workspaceId});
 if(inventory.workspace.id!==options.workspaceId||inventory.workspace.projects.pageInfo.hasNextPage)throw Error('Incomplete Worker workspace inventory');
 if(!options.controlProjectId||options.controlProjectId===options.workerProjectId)throw Error('Worker pools require two distinct existing projects');
 options.onStage?.('verify');
 return [
  {projectId:options.controlProjectId,environmentId:options.controlEnvironmentId,capacity:2 as const,region:options.region},
  {projectId:options.workerProjectId,environmentId:options.workerEnvironmentId,capacity:2 as const,region:options.region},
 ].map(pool=>{
  const project=inventory.workspace.projects.edges.find(entry=>entry.node.id===pool.projectId)?.node;
  if(!project||project.environments.pageInfo.hasNextPage||!project.environments.edges.some(entry=>entry.node.id===pool.environmentId))throw Error('Worker pool project does not belong to configured workspace/environment');
  return pool;
 }) as [WorkerPool,WorkerPool];
}
