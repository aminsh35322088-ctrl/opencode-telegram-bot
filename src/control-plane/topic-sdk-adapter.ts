import { randomUUID } from "node:crypto";
import { nodeBindings } from "./node-bindings.js";
import { resolveTopicNodeClient } from "./topic-node-client.js";
import type { TopicRuntimeContext } from "../app/services/topic-runtime-context.js";
import { startRemoteTopicRunEvents } from "../opencode/topic-event-bus.js";
interface Options { parentID?: string; sessionID?: string; requestID?: string; answers?: string[][]; parts?: unknown[]; model?: unknown; agent?: string; variant?: string; directory?: string }
const runs = new Map<string,string>();
export function getRemoteRunId(sessionId: string): string | undefined { return runs.get(sessionId); }
export async function invokeTopicSdk(topic: TopicRuntimeContext, operation: string, arguments_: unknown[]): Promise<{handled:boolean; result?:unknown}> {
  const binding = await nodeBindings.find(topic.chatId,topic.threadId);
  if (!binding) return {handled:false};
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
    case "session.status": return request("session.status");
    case "session.list": {
      if(!binding.sessionId) return {handled:true,result:{data:[]}};
      const session = await client.request("session.get",{},requestOptions);
      return {handled:true,result:{data:[sessionInfo(session)]}};
    }
    case "session.messages": return request("session.messages");
    case "session.delete": return request("session.delete");
    case "session.abort": {
      if (!binding.sessionId) throw new Error("Remote active session unavailable");
      if(!runs.has(binding.sessionId)) {
        const statuses=await client.request<Record<string,{type:string}>>("session.status",{},requestOptions);
        if(!statuses[binding.sessionId] || statuses[binding.sessionId]?.type === "idle") return {handled:true,result:{data:true}};
        throw new Error("Remote active run identity unavailable");
      }
      return request("stop",{runId:runs.get(binding.sessionId)});
    }
    case "question.list": return request("question.list");
    case "question.reply": {
      const runId=binding.sessionId ? runs.get(binding.sessionId) : undefined;
      if(!runId || !options.requestID || !options.answers) throw new Error("Remote Question lacks active run identity");
      return request("question.reply",{runId,requestId:options.requestID,answers:options.answers});
    }
    case "session.promptAsync": {
      if(!binding.sessionId || !options.parts || !options.directory) throw new Error("Remote prompt lacks bound session/workspace");
      const runId=randomUUID();
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
