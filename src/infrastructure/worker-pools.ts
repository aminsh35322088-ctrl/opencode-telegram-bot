import type {WorkerPool} from './node-provisioner.js';
interface Connection<T>{edges:Array<{node:T}>;pageInfo:{hasNextPage:boolean}}
interface Project{id:string;name:string;environments:Connection<{id:string;name:string}>}
interface Options{request<T>(document:string,variables:Record<string,unknown>):Promise<T>;workspaceId?:string;controlProjectId:string;controlEnvironmentId:string;workerProjectId?:string;workerEnvironmentId?:string;region:string;onStage?:(stage:'inventory'|'verify')=>void}
/** Verify existing projects only. Provisioning must never create a third project. */
export async function resolveWorkerPools(options:Options):Promise<[WorkerPool,WorkerPool]>{
 options.onStage?.('inventory');
 const workspaceId=options.workspaceId||(await options.request<{project:{workspaceId:string}}>('query WorkerWorkspace($projectId:String!){project(id:$projectId){workspaceId}}',{projectId:options.controlProjectId})).project.workspaceId;
 const inventory=await options.request<{workspace:{id:string;projects:Connection<Project>}}>('query WorkerPools($workspaceId:String!){workspace(workspaceId:$workspaceId){id projects(first:100){pageInfo{hasNextPage} edges{node{id name environments(first:100){pageInfo{hasNextPage} edges{node{id name}}}}}}}}',{workspaceId});
 if(inventory.workspace.id!==workspaceId||inventory.workspace.projects.pageInfo.hasNextPage)throw Error('Incomplete Worker workspace inventory');
 const candidates=inventory.workspace.projects.edges.filter(entry=>entry.node.name==='opencode-topic-validation');
 if(!options.workerProjectId && candidates.length!==1)throw Error('Existing Worker project requires unambiguous ownership');
 const workerProjectId=options.workerProjectId??candidates[0]!.node.id;
 const workerProject=inventory.workspace.projects.edges.find(entry=>entry.node.id===workerProjectId)?.node;
 const namedEnvironments=workerProject?.environments.edges.filter(entry=>entry.node.name==='validation')??[];
 if(!options.workerEnvironmentId && namedEnvironments.length>1)throw Error('Ambiguous Worker validation environment');
 const workerEnvironmentId=options.workerEnvironmentId??(namedEnvironments.length===1?namedEnvironments[0]!.node.id:workerProject?.environments.edges.length===1?workerProject.environments.edges[0]?.node.id:undefined);
 if(!workerEnvironmentId)throw Error('Existing Worker environment requires unambiguous ownership');
 if(!options.controlProjectId||options.controlProjectId===workerProjectId)throw Error('Worker pools require two distinct existing projects');
 options.onStage?.('verify');
 return [
  {projectId:options.controlProjectId,environmentId:options.controlEnvironmentId,capacity:2 as const,region:options.region},
  {projectId:workerProjectId,environmentId:workerEnvironmentId,capacity:2 as const,region:options.region},
 ].map(pool=>{
  const project=inventory.workspace.projects.edges.find(entry=>entry.node.id===pool.projectId)?.node;
  if(!project||project.environments.pageInfo.hasNextPage||!project.environments.edges.some(entry=>entry.node.id===pool.environmentId))throw Error('Worker pool project does not belong to configured workspace/environment');
  return pool;
 }) as [WorkerPool,WorkerPool];
}
