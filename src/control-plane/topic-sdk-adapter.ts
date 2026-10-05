import { randomUUID } from "node:crypto";
import { nodeBindings } from "./node-bindings.js";
import { resolveTopicNodeClient } from "./topic-node-client.js";
import { runInTopicRuntimeContext } from "../app/services/topic-runtime-context.js";
import { getNativeCore, resolveCoreTopicBinding, restoreRemoteCoreRun } from "../core/native-core-service.js";
import type { TopicRuntimeContext } from "../app/services/topic-runtime-context.js";
import { hasRemoteTopicRunEvents, startRemoteTopicRunEvents } from "../opencode/topic-event-bus.js";
interface Options { parentID?: string; sessionID?: string; requestID?: string; answers?: string[][]; parts?: unknown[]; model?: unknown; agent?: string; variant?: string; directory?: string }
const runs = new Map<string,string>();
export function getRemoteRunId(sessionId: string): string | undefined { return runs.get(sessionId); }
/** One request-driven recovery attempt; never starts an idle heartbeat or retry loop. */
const recoveryFlights=new Map<string,Promise<string|null>>();
export async function recoverRemoteTopicRun(topic:TopicRuntimeContext, reconnect=false, signal?:AbortSignal):Promise<string|null> {
  const binding=await nodeBindings.find(topic.chatId,topic.threadId);
  if(!binding?.sessionId)throw new Error("Remote recovery lacks owned session");
  if(topic.sessionId&&topic.sessionId!==binding.sessionId)throw new Error("Remote recovery session mismatch");
  const client=await resolveTopicNodeClient(topic.chatId,topic.threadId);
  if(!client)throw new Error("Remote recovery node unavailable");
  const status=await client.request<{continuation?:string;externalRunId?:unknown}|null>("status",{}, {signal});
  if(status?.continuation!=="live"){runs.delete(binding.sessionId);return null;}
  if(typeof status.externalRunId!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(status.externalRunId))throw new Error("Signed active status lacks exact run identity");
  const runId=status.externalRunId; runs.set(binding.sessionId,runId);
  if(reconnect&&!hasRemoteTopicRunEvents(binding.sessionId)) {
    if(!topic.directory)throw new Error("Remote reconnect lacks Topic workspace route");
    const key=`${binding.nodeId}:${binding.generation}:${binding.sessionId}`;
    const existing=recoveryFlights.get(key);if(existing)return existing;
    if(getNativeCore())await runInTopicRuntimeContext({...topic,sessionId:binding.sessionId},()=>restoreRemoteCoreRun(binding.sessionId!,topic.directory!,runId));
    const operation=startRemoteTopicRunEvents(topic,binding.sessionId,topic.directory,runId,()=>{if(runs.get(binding.sessionId!)===runId)runs.delete(binding.sessionId!);},"resume").then(()=>runId).finally(()=>{if(recoveryFlights.get(key)===operation)recoveryFlights.delete(key);});
    recoveryFlights.set(key,operation);return operation;
  }
  return runId;
}
export async function invokeTopicSdk(topic: TopicRuntimeContext, operation: string, arguments_: unknown[]): Promise<{handled:boolean; result?:unknown}> {
  const binding = await nodeBindings.find(topic.chatId,topic.threadId);
  if (!binding) {
    const historical=(await nodeBindings.list()).some(item=>item.chatId===topic.chatId&&item.threadId===topic.threadId);
    if(historical)throw new Error("Retired Topic node cannot fall back to local Core");
    return {handled:false};
  }
  const client = await resolveTopicNodeClient(topic.chatId,topic.threadId);
  if (!client) throw new Error("Topic node unavailable");
  const options = (arguments_[0] ?? {}) as Options;
  const requestOptions = arguments_[1] as {signal?:AbortSignal} | undefined;
  if (options.sessionID && options.sessionID !== binding.sessionId) throw new Error("SDK session does not belong to Topic node");
  const sessionInfo = (value:unknown):unknown => value && typeof value === "object" ? {...value,directory:options.directory ?? topic.directory ?? "/data/topic"} : value;
  const request = async (name:string,payload:unknown={}) => ({handled:true,result:{data:await client.request(name,payload,requestOptions)}});
  switch(operation) {
    case "session.create": {
      if(options.parentID) throw new Error("Remote temporary sessions must be owned by Worker Core");
      const created=await client.request<{sessionId:string}>("session.create",{},requestOptions);
      await nodeBindings.update(binding.nodeId,binding.generation,{sessionId:created.sessionId});
      const refreshed=await resolveTopicNodeClient(topic.chatId,topic.threadId);
      return {handled:true,result:{data:sessionInfo(await refreshed!.request("session.get",{},requestOptions))}};
    }
    case "session.get": return {handled:true,result:{data:sessionInfo(await client.request("session.get",{},requestOptions))}};
    case "session.status": {
      await recoverRemoteTopicRun({...topic,directory:options.directory??topic.directory},true,requestOptions?.signal);
      return request("session.status");
    }
    case "session.list": {
      if(!binding.sessionId) return {handled:true,result:{data:[]}};
      const session = await client.request("session.get",{},requestOptions);
      return {handled:true,result:{data:[sessionInfo(session)]}};
    }
    case "session.messages": return request("session.messages");
    case "session.delete": return request("session.delete");
    case "session.abort": {
      if (!binding.sessionId) throw new Error("Remote active session unavailable");
      const runId=await recoverRemoteTopicRun(topic,false,requestOptions?.signal);
      if(!runId)return {handled:true,result:{data:true}};
      return request("stop",{runId});
    }
    case "question.list": return request("question.list");
    case "question.reply": {
      const runId=binding.sessionId ? await recoverRemoteTopicRun({...topic,directory:options.directory??topic.directory},true,requestOptions?.signal) : undefined;
      if(!runId || !options.requestID || !options.answers) throw new Error("Remote Question lacks active run identity");
      return request("question.reply",{runId,requestId:options.requestID,answers:options.answers});
    }
    case "session.promptAsync": {
      if(!binding.sessionId || !options.parts || !options.directory) throw new Error("Remote prompt lacks bound session/workspace");
      const coreRoute=resolveCoreTopicBinding(topic.chatId,topic.threadId);
      const runId=(coreRoute?getNativeCore()?.runs.current(coreRoute.bindingId)?.runId:undefined)??randomUUID();
      if(runs.has(binding.sessionId)) throw new Error("Remote Topic already owns an active run");
      runs.set(binding.sessionId,runId);
      try {
        // Root transport must acknowledge the native event stream before dispatching any model work.
        const stopEvents=await startRemoteTopicRunEvents(topic,binding.sessionId,options.directory,runId,()=>runs.delete(binding.sessionId!));
        try {
          await client.request("run",{runId,parts:options.parts,...(options.model?{model:options.model}:{}),...(options.agent?{agent:options.agent}:{}),...(options.variant && options.variant!=="default"?{variant:options.variant}:{})},requestOptions);
        } catch(error) {stopEvents();throw error;}
        return {handled:true,result:{data:undefined}};
      } catch(error) {runs.delete(binding.sessionId);throw error;}
    }
    default: throw new Error(`Remote Topic SDK operation unsupported: ${operation}`);
  }
}
