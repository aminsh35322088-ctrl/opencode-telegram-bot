import type {WorkerPool} from './worker-provisioning-driver.js';
interface Connection<T>{edges:Array<{node:T}>;pageInfo:{hasNextPage:boolean}}
interface Project{id:string;name:string;deletedAt?:string|null;environments:Connection<{id:string;name:string}>}
interface Options{request<T>(document:string,variables:Record<string,unknown>):Promise<T>;workspaceId?:string;controlProjectId:string;controlEnvironmentId:string;workerProjectId?:string;workerEnvironmentId?:string;region:string;pools?:WorkerPool[];onStage?:(stage:'inventory'|'verify')=>void;onDeletedProjects?:(ids:string[])=>void}
/** Verify eligible existing projects; no project creation or fixed slot topology. */
export async function resolveWorkerPools(options:Options):Promise<WorkerPool[]>{
 options.onStage?.('inventory');
 const workspaceId=options.workspaceId||(await options.request<{project:{workspaceId:string}}>('query WorkerWorkspace($projectId:String!){project(id:$projectId){workspaceId}}',{projectId:options.controlProjectId})).project.workspaceId;
 const inventory=await options.request<{workspace:{id:string;projects:Connection<Project>}}>('query WorkerPools($workspaceId:String!){workspace(workspaceId:$workspaceId){id projects(first:100){pageInfo{hasNextPage} edges{node{id name deletedAt environments(first:100){pageInfo{hasNextPage} edges{node{id name}}}}}}}}',{workspaceId});
 if(inventory.workspace.id!==workspaceId||inventory.workspace.projects.pageInfo.hasNextPage)throw Error('Incomplete Worker workspace inventory');
 options.onDeletedProjects?.(inventory.workspace.projects.edges.filter(e=>Boolean(e.node.deletedAt)).map(e=>e.node.id));
 inventory.workspace.projects.edges=inventory.workspace.projects.edges.filter(e=>!e.node.deletedAt);
 if(options.pools){options.onStage?.('verify');return options.pools.map(pool=>{
 if(pool.projectId===options.controlProjectId)throw Error('Control project cannot be used as a Worker pool');
 const project=inventory.workspace.projects.edges.find(e=>e.node.id===pool.projectId)?.node;
 if(!project||project.environments.pageInfo.hasNextPage||!project.environments.edges.some(e=>e.node.id===pool.environmentId)||pool.capacity!==undefined&&(!Number.isSafeInteger(pool.capacity)||pool.capacity<0))throw Error('Worker pool project does not belong to configured workspace/environment');
 return pool;});}
 if(options.workerProjectId===options.controlProjectId)throw Error('Duplicate Worker pool project');
 const configured=options.workerProjectId?inventory.workspace.projects.edges.filter(e=>e.node.id===options.workerProjectId):inventory.workspace.projects.edges.filter(e=>e.node.id!==options.controlProjectId&&e.node.name.startsWith('opencode-topic-'));
 const pools:WorkerPool[]=[];
 for(const {node:project} of configured){
  if(project.id===options.controlProjectId)throw Error('Control project cannot be used as a Worker pool');
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

interface CreateWorkerPoolOptions{request<T>(document:string,variables:Record<string,unknown>):Promise<T>;workspaceId:string;region:string;excludedProjectIds?:ReadonlySet<string>}
/** Create exactly one deterministic overflow project after existing pools are exhausted. */
export async function createWorkerPool(options:CreateWorkerPoolOptions):Promise<WorkerPool>{
 const inventory=await options.request<{projects:Connection<{id:string;name:string;deletedAt?:string|null}>}>('query WorkerPoolExpansionInventory($workspaceId:String!){projects(workspaceId:$workspaceId,first:100){pageInfo{hasNextPage} edges{node{id name deletedAt}}}}',{workspaceId:options.workspaceId});
 if(inventory.projects.pageInfo.hasNextPage)throw Error('Incomplete Worker project inventory');
 inventory.projects.edges=inventory.projects.edges.filter(edge=>!edge.node.deletedAt);
 const names=new Set(inventory.projects.edges.map(edge=>edge.node.name));
 const excluded=options.excludedProjectIds??new Set<string>();
 const recoverable=inventory.projects.edges.map(edge=>edge.node).filter(project=>/^opencode-topic-\d{2,}$/u.test(project.name)&&!excluded.has(project.id)).sort((a,b)=>a.name.localeCompare(b.name));
 let projectId:string;let name:string;
 if(recoverable[0]){projectId=recoverable[0].id;name=recoverable[0].name;}
 else{
  let index=1;name='';
  do{name=`opencode-topic-${String(index++).padStart(2,'0')}`;}while(names.has(name)&&index<=1000);
  if(!name||names.has(name))throw Error('Worker project namespace exhausted');
  const created=(await options.request<{projectCreate:{id:string;name:string}}>('mutation WorkerPoolCreate($input:ProjectCreateInput!){projectCreate(input:$input){id name}}',{input:{name,workspaceId:options.workspaceId}})).projectCreate;
  if(!created?.id||created.name!==name)throw Error('Worker project creation mismatch');
  projectId=created.id;
 }
 const project=(await options.request<{project:{id:string;name:string;environments:Connection<{id:string;name:string}>}}>('query WorkerPoolCreated($projectId:String!){project(id:$projectId){id name environments(first:100){pageInfo{hasNextPage} edges{node{id name}}}}}',{projectId})).project;
 if(project.id!==projectId||project.name!==name||project.environments.pageInfo.hasNextPage)throw Error('Worker project verification failed');
 const production=project.environments.edges.filter(edge=>edge.node.name==='production');
 if(production.length!==1)throw Error('Worker project production environment missing');
 return {projectId:project.id,environmentId:production[0]!.node.id,region:options.region};
}
