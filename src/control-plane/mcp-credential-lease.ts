import {createHash} from 'node:crypto';
import type {McpCredentialRecord} from '../app/services/mcp-credential-store.js';
interface Dependencies {state():Promise<Record<string,unknown>>;credential(directory:string,name:string):Promise<McpCredentialRecord|null>;now():number}
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
function cleanEndpoint(value:unknown):string {
 if(typeof value!=='string')throw Error('MCP credential capability denied');
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.port&&url.port!=='443')throw Error('MCP credential capability denied');
 return url.toString();
}
/** Existing encrypted MCP vault remains canonical; no lease is persisted or materialized into Core. */
export async function leaseMcpCredential(payload:Record<string,unknown>,dependencies:Dependencies):Promise<{headers:Record<string,string>;expiresAt:number}> {
 if(payload.purpose!=='mcp.request'||typeof payload.capability!=='string'||!payload.capability.startsWith('mcp:')||typeof payload.credentialId!=='string')throw Error('MCP credential capability denied');
 const name=payload.capability.slice(4);
 if(!name||/railway|telegram/i.test(name))throw Error('MCP credential capability denied');
 const state=await dependencies.state();
 const records=object(object(state.mcpServers).records);
 const matches=Object.entries(records).filter(([,candidate])=>object(candidate).name===name);
 if(matches.length!==1)throw Error('MCP credential capability denied');
 const [id,candidate]=matches[0]!;const server=object(candidate);const config=object(server.config);
 if(id!==payload.credentialId||typeof server.projectDirectory!=='string'||config.type!=='remote'||config.enabled===false)throw Error('MCP credential capability denied');
 const normalizedDirectory=server.projectDirectory.trim().replace(/\\/g,'/').replace(/\/+$/u,'');
 const expected=createHash('sha256').update(normalizedDirectory).update('\0').update(name.trim()).digest('hex');
 if(expected!==id||!Object.hasOwn(object(object(state.mcpCredentials).records),id))throw Error('MCP credential unavailable');
 const endpoint=cleanEndpoint(config.url);
 if(cleanEndpoint(payload.endpoint)!==endpoint)throw Error('MCP credential capability denied');
 const credential=await dependencies.credential(server.projectDirectory,name);
 if(!credential||credential.serverName!==name||cleanEndpoint(credential.remoteUrl)!==endpoint||credential.mode==='oauth-client')throw Error('MCP credential unavailable');
 const headerName=credential.mode==='bearer'?'Authorization':credential.headerName;
 const headerValue=credential.mode==='bearer'?`Bearer ${credential.secret}`:credential.secret;
 if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName)||/^(?:host|connection|transfer-encoding|content-length|cookie|set-cookie|proxy-authorization|proxy-connection|upgrade|trailer|te)$/i.test(headerName)||!headerValue||headerValue.length>16384||/[\x00-\x1f\x7f]/.test(headerValue))throw Error('MCP credential unavailable');
 return {headers:{[headerName]:headerValue},expiresAt:dependencies.now()+60000};
}
