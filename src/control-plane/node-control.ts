import { randomUUID } from "node:crypto";
import type { NodeEnvelope, NodeIdentity } from "./node-protocol.js";
import { NodeProtocol } from "./node-protocol.js";

export interface NodeControlBinding extends NodeIdentity {sessionId?: string; status: string;}
export interface NodeControlDependencies {
  protocol: NodeProtocol;
  /** Implemented in infrastructure identity owner, never exposed to the model runtime. */
  resolveIdentity(nodeId: string): Promise<{binding: NodeControlBinding; secret: string} | null>;
  dispatch(envelope: NodeEnvelope): Promise<unknown>;
}
const operations = new Set(["snapshot.get", "credential.get", "mutation.prepare", "mutation.commit"]);

/** Narrow authenticated surface; transport supplies bounded raw UTF-8 input. */
export async function handleNodeControl(body: string, signature: string, dependencies: NodeControlDependencies) {
  let candidate: unknown;
  try {candidate=JSON.parse(body);} catch {throw new Error("Node request denied");}
  const nodeId=candidate && typeof candidate==="object" ? (candidate as {nodeId?:unknown}).nodeId : undefined;
  if (typeof nodeId!=="string" || nodeId.length>128) throw new Error("Node request denied");
  const identity=await dependencies.resolveIdentity(nodeId);
  if (!identity || !["provisioning","bootstrapping","ready","recovering","available"].includes(identity.binding.status)) throw new Error("Node request denied");
  const {nodeId: boundNodeId,generation,chatId,threadId}=identity.binding;
  const envelope=await dependencies.protocol.verify(body,signature,{nodeId:boundNodeId,generation,chatId,threadId},identity.secret);
  if (threadId===0 && chatId===0 && envelope.operation!=="snapshot.get")throw new Error("Unbound Node operation denied");
  if (!operations.has(envelope.operation)) throw new Error("Node operation denied");
  if (envelope.operation!=="snapshot.get" && (!identity.binding.sessionId || envelope.sessionId!==identity.binding.sessionId)) throw new Error("Node session denied");
  const payload=await dependencies.dispatch(envelope);
  return dependencies.protocol.sign({...envelope,payload,timestamp:Date.now(),nonce:randomUUID().replaceAll("-","")},identity.secret);
}
