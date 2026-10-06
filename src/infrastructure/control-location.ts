interface Options{request<T>(document:string,variables:Record<string,unknown>):Promise<T>;projectId:string;environmentId:string;serviceId:string;publicUrl?:string}
/** Discover only this deployment's narrow gateway; never inspect secret variables. */
export async function resolveControlUrl(options:Options):Promise<string>{
 if(options.publicUrl){const endpoint=new URL(options.publicUrl);if(endpoint.protocol!=='https:'||!endpoint.hostname.endsWith('.up.railway.app')||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash)throw Error('Invalid Control gateway domain');return endpoint.origin;}
 if(!options.projectId||!options.environmentId||!options.serviceId)throw Error('Railway deployment identity unavailable');
 const inventory=await options.request<{environment:{id:string;projectId:string;serviceInstances:{pageInfo:{hasNextPage:boolean};edges:Array<{node:{serviceId:string;domains:{serviceDomains:Array<{domain:string;targetPort:number|null}>}}}>}}}>('query ControlGateway($environmentId:String!){environment(id:$environmentId){id projectId serviceInstances(first:100){pageInfo{hasNextPage} edges{node{serviceId domains{serviceDomains{domain targetPort}}}}}}}',{environmentId:options.environmentId});
 if(inventory.environment.id!==options.environmentId||inventory.environment.projectId!==options.projectId||inventory.environment.serviceInstances.pageInfo.hasNextPage)throw Error('Control gateway ownership unavailable');
 const service=inventory.environment.serviceInstances.edges.find(entry=>entry.node.serviceId===options.serviceId)?.node;
 if(!service)throw Error('Control gateway service unavailable');
 const domains=service.domains.serviceDomains.filter(domain=>domain.targetPort===8080);
 if(domains.length>1)throw Error('Ambiguous Control gateway domain');
 const domain=domains[0]?.domain??(await options.request<{serviceDomainCreate:{domain:string}}>('mutation ControlGatewayDomain($input:ServiceDomainCreateInput!){serviceDomainCreate(input:$input){domain}}',{input:{environmentId:options.environmentId,serviceId:options.serviceId,targetPort:8080}})).serviceDomainCreate.domain;
 if(!/^[a-z0-9-]+\.up\.railway\.app$/.test(domain))throw Error('Invalid Control gateway domain');
 return `https://${domain}`;
}
