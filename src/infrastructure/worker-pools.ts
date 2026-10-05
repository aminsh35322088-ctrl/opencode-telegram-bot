import type {WorkerPool} from './node-provisioner.js';
interface Connection<T>{edges:Array<{node:T}>;pageInfo:{hasNextPage:boolean}}
interface Project{id:string;name:string;environments:Connection<{id:string;name:string}>}
interface Options{request<T>(document:string,variables:Record<string,unknown>):Promise<T>;workspaceId:string;workerProjectId:string;workerEnvironmentId:string;region:string}
/** Fixed root-only project reconciliation. Credentials never leave the injected private API client. */
export async function resolveWorkerPools(options:Options):Promise<[WorkerPool,WorkerPool]>{
 const inventory=await options.request<{workspace:{id:string;projects:Connection<Project>}}>('query WorkerPools($workspaceId:String!){workspace(workspaceId:$workspaceId){id projects(first:100){pageInfo{hasNextPage} edges{node{id name environments(first:100){pageInfo{hasNextPage} edges{node{id name}}}}}}}}',{workspaceId:options.workspaceId});
 if(inventory.workspace.id!==options.workspaceId||inventory.workspace.projects.pageInfo.hasNextPage)throw Error('Incomplete Worker workspace inventory');
 const first=inventory.workspace.projects.edges.find(entry=>entry.node.id===options.workerProjectId)?.node;
 if(!first||first.environments.pageInfo.hasNextPage||!first.environments.edges.some(entry=>entry.node.id===options.workerEnvironmentId))throw Error('Worker validation project does not belong to configured workspace/environment');
 const candidates=inventory.workspace.projects.edges.filter(entry=>entry.node.name==='opencode-topic-workers-b');
 if(candidates.length>1)throw Error('Ambiguous independent Worker project');
 let second=candidates[0]?.node;
 if(!second){
  // On an ambiguous response, the next deployment finds this fixed name instead of blindly creating again.
  const created=await options.request<{projectCreate:Project}>('mutation WorkerPoolCreate($input:ProjectCreateInput!){projectCreate(input:$input){id name environments(first:100){pageInfo{hasNextPage} edges{node{id name}}}}}',{input:{workspaceId:options.workspaceId,name:'opencode-topic-workers-b',defaultEnvironmentName:'production',isPublic:false,prDeploys:false}});
  second=created.projectCreate;
 }
 const environment=second.environments.edges.find(entry=>entry.node.name==='production')?.node;
 if(second.id===first.id||second.name!=='opencode-topic-workers-b'||second.environments.pageInfo.hasNextPage||!environment)throw Error('Independent Worker project is not verified');
 return [{projectId:first.id,environmentId:options.workerEnvironmentId,capacity:3,region:options.region},{projectId:second.id,environmentId:environment.id,capacity:1,region:options.region}];
}
