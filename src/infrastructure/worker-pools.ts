import type {WorkerPool} from './worker-provisioning-driver.js';
interface Connection<T>{edges:Array<{node:T}>;pageInfo:{hasNextPage:boolean}}
interface Project{id:string;name:string;environments:Connection<{id:string;name:string}>}
interface Options{request<T>(document:string,variables:Record<string,unknown>):Promise<T>;workspaceId?:string;controlProjectId:string;controlEnvironmentId:string;workerProjectId?:string;workerEnvironmentId?:string;region:string;pools?:WorkerPool[];onStage?:(stage:'inventory'|'verify')=>void}
/** Verify eligible existing projects; no project creation or fixed slot topology. */
export async function resolveWorkerPools(options:Options):Promise<WorkerPool[]>{
 options.onStage?.('inventory');
 const workspaceId=options.workspaceId||(await options.request<{project:{workspaceId:string}}>('query WorkerWorkspace($projectId:String!){project(id:$projectId){workspaceId}}',{projectId:options.controlProjectId})).project.workspaceId;
 const inventory=await options.request<{workspace:{id:string;projects:Connection<Project>}}>('query WorkerPools($workspaceId:String!){workspace(workspaceId:$workspaceId){id projects(first:100){pageInfo{hasNextPage} edges{node{id name environments(first:100){pageInfo{hasNextPage} edges{node{id name}}}}}}}}',{workspaceId});
 if(inventory.workspace.id!==workspaceId||inventory.workspace.projects.pageInfo.hasNextPage)throw Error('Incomplete Worker workspace inventory');
 if(options.pools){options.onStage?.('verify');return options.pools.map(pool=>{
 const project=inventory.workspace.projects.edges.find(e=>e.node.id===pool.projectId)?.node;
 if(!project||project.environments.pageInfo.hasNextPage||!project.environments.edges.some(e=>e.node.id===pool.environmentId)||pool.capacity!==undefined&&(!Number.isSafeInteger(pool.capacity)||pool.capacity<0))throw Error('Worker pool project does not belong to configured workspace/environment');
 return pool;});}
 const configured=options.workerProjectId?inventory.workspace.projects.edges.filter(e=>e.node.id===options.workerProjectId):inventory.workspace.projects.edges.filter(e=>e.node.name.startsWith('opencode-topic-'));
 const pools:WorkerPool[]=[{projectId:options.controlProjectId,environmentId:options.controlEnvironmentId,region:options.region}];
 for(const {node:project} of configured){
  if(project.id===options.controlProjectId)throw Error('Duplicate Worker pool project');
  const preferred=project.environments.edges.filter(e=>e.node.name==='validation');
  const environmentId=options.workerEnvironmentId??(preferred.length===1?preferred[0]!.node.id:project.environments.edges.length===1?project.environments.edges[0]!.node.id:undefined);
  if(!environmentId)throw Error('Existing Worker environment requires unambiguous ownership');
  pools.push({projectId:project.id,environmentId,region:options.region});
 }
 if(options.workerProjectId&&!configured.length)throw Error('Worker pool project does not belong to configured workspace/environment');
 options.onStage?.('verify');
 return pools.map(pool=>{
  const project=inventory.workspace.projects.edges.find(entry=>entry.node.id===pool.projectId)?.node;
  if(!project||project.environments.pageInfo.hasNextPage||!project.environments.edges.some(entry=>entry.node.id===pool.environmentId))throw Error('Worker pool project does not belong to configured workspace/environment');
  return pool;
 });
}
