import type {NodeEnvelope} from "./node-protocol.js";
import {runWithAuthenticatedMutationActor} from "./actor-context.js";

/** Called only after root transport authenticated and fenced the envelope. */
export async function dispatchAuthenticatedNodeControl(envelope: NodeEnvelope): Promise<unknown> {
  if (envelope.operation==="snapshot.get") {
    const {readGlobalSnapshot}=await import("./global-state.js");
    return await readGlobalSnapshot();
  }
  if (!envelope.sessionId) throw new Error("Bound node session required");
  const actor={nodeId:envelope.nodeId,generation:envelope.generation,chatId:envelope.chatId,threadId:envelope.threadId,sessionId:envelope.sessionId};
  return await runWithAuthenticatedMutationActor(actor,async()=>{
    const payload=envelope.payload;
    if (!payload || typeof payload!=="object" || Array.isArray(payload)) throw new Error("Invalid control payload");
    const data=payload as Record<string,unknown>;
    if (envelope.operation==="credential.get") {
      if (data.purpose!=="provider.request" || typeof data.capability!=="string" || typeof data.credentialId!=="string" ||
        /railway|telegram/i.test(`${data.capability}:${data.credentialId}`)) throw new Error("Credential capability denied");
      if(data.capability.startsWith("free-provider:") && data.credentialId==="public-auth"){
        const {resolvePublicGlobalProviderCredential}=await import("../app/services/free-llm-catalog-service.js");
        const value=await resolvePublicGlobalProviderCredential(data.capability.slice("free-provider:".length));
        if(!value)throw new Error("Credential unavailable");
        return {value,expiresAt:Date.now()+60_000};
      }
      const {getStoredExtension}=await import("../app/services/extension-store.js");
      const extension=await getStoredExtension(data.capability);
      if (!extension || extension.kind!=="model-provider" || !extension.credentialSchemas.some(schema=>schema.id===data.credentialId && schema.transport.kind==="provider-api-key")) throw new Error("Credential capability denied");
      const {readGlobalSnapshot}=await import("./global-state.js");
      const snapshot=await readGlobalSnapshot();
      const available=(snapshot.configuration.extensions as Array<{id?:string;enabled?:boolean;userDisabled?:boolean}> | undefined)?.find(item=>item.id===extension.id);
      if (!available || available.enabled===false || available.userDisabled===true) throw new Error("Credential capability disabled");
      const {resolveExtensionCredential}=await import("../app/services/credential-vault-service.js");
      const value=await resolveExtensionCredential(extension.id,data.credentialId);
      if (!value) throw new Error("Credential unavailable");
      return {value,expiresAt:Date.now()+60_000};
    }
    const {prepareGlobalMutation,commitPreparedGlobalMutation}=await import("./mutations.js");
    const mutation=data.mutation as {type?:unknown;resource?:unknown;config?:unknown} | undefined;
    if (!mutation || typeof mutation.type!=="string" || typeof mutation.resource!=="string" || !mutation.config || typeof mutation.config!=="object" || Array.isArray(mutation.config)) throw new Error("Invalid Global mutation");
    const exact={type:mutation.type,resource:mutation.resource,config:mutation.config as Record<string,unknown>};
    if(envelope.operation==="mutation.prepare") return await prepareGlobalMutation(actor,exact);
    if(envelope.operation==="mutation.commit" && typeof data.approvalId==="string") return await commitPreparedGlobalMutation(actor,data.approvalId,exact);
    throw new Error("Unsupported control operation");
  });
}
