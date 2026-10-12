import {randomBytes,timingSafeEqual} from "node:crypto";
import type {captureNodeRegistry} from "./node-registry.js";

interface BootstrapIdentity {nodeId:string;generation:number;chatId:number;threadId:number}
interface GrantInput {identity:BootstrapIdentity;endpoint:string;secret:string;serviceId:string;projectId:string}
interface Grant extends GrantInput {token:string;expiresAt:number}

/** Root-only one-use capability store for in-place Worker generation rotation. */
export class NodeBootstrapGrantStore {
  private readonly grants=new Map<string,Grant>();
  constructor(
    private readonly registry:ReturnType<typeof captureNodeRegistry>,
    private readonly registryPath:string,
    private readonly now:()=>number=Date.now,
    private readonly ttlMs=60_000,
  ) {}
  private prune():void {const now=this.now();for(const [token,grant] of this.grants)if(grant.expiresAt<=now)this.grants.delete(token);}
  async issue(input:GrantInput):Promise<string>{
    this.prune();
    if(this.grants.size>=32)throw new Error("Bootstrap grant capacity exceeded");
    const {identity,endpoint,secret,serviceId,projectId}=input;const url=new URL(endpoint);
    const unbound=identity?.chatId===0&&identity?.threadId===0;
    if(!identity?.nodeId||identity.nodeId.length>128||!Number.isSafeInteger(identity.generation)||identity.generation<1||!Number.isSafeInteger(identity.chatId)||!Number.isSafeInteger(identity.threadId)||(!unbound&&(identity.chatId===0||identity.threadId<=1)))throw new Error("Invalid bootstrap identity");
    if(url.protocol!=="https:"||!url.hostname.endsWith(".up.railway.app")||url.username||url.password||url.search||url.hash||url.pathname!=="/")throw new Error("Invalid bootstrap endpoint");
    if(typeof secret!=="string"||secret.length<64||!/^[A-Za-z0-9_-]+$/.test(secret)||!serviceId||!projectId||serviceId.length>256||projectId.length>256)throw new Error("Invalid bootstrap grant");
    const token=randomBytes(48).toString("base64url");
    this.grants.set(token,{identity:structuredClone(identity),endpoint,secret,serviceId,projectId,token,expiresAt:this.now()+this.ttlMs});
    return token;
  }
  async consume(input:{bootstrapToken:string;serviceId:string;projectId:string}):Promise<{version:1;identity:BootstrapIdentity;secret:string}>{
    this.prune();
    if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).sort().join(",")!=="bootstrapToken,projectId,serviceId"||typeof input.bootstrapToken!=="string"||input.bootstrapToken.length<48||typeof input.serviceId!=="string"||typeof input.projectId!=="string")throw new Error("Invalid bootstrap grant");
    const grant=this.grants.get(input.bootstrapToken);
    if(!grant)throw new Error("Bootstrap grant unavailable");
    const equal=(left:string,right:string)=>{const a=Buffer.from(left),b=Buffer.from(right);return a.length===b.length&&timingSafeEqual(a,b);};
    if(!equal(grant.serviceId,input.serviceId)||!equal(grant.projectId,input.projectId))throw new Error("Bootstrap grant scope mismatch");
    // One-use before any externally visible state change. A persistence failure is fail-closed.
    this.grants.delete(input.bootstrapToken);
    this.registry.install({binding:{...grant.identity,status:"provisioning"},endpoint:grant.endpoint,secret:grant.secret});
    await this.registry.persist(this.registryPath);
    return {version:1,identity:structuredClone(grant.identity),secret:grant.secret};
  }
}
