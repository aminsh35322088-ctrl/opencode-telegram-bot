import { opencodeClient } from "../../opencode/client.js";
import path from "node:path";
import { getStoredModel } from "./model-selection-service.js";
import { listTopicRuntimeStates } from "../stores/topic-runtime-state-store.js";
import { getEffectiveCurrentSession } from "./session-service.js";

export interface SessionActionScope { sessionID: string; directory: string; }

async function current(scope?: SessionActionScope) {
  if (scope?.sessionID && scope.directory) return { id: scope.sessionID, title: "OpenCode Session", directory: scope.directory };
  const session = await getEffectiveCurrentSession();
  if (!session) throw new Error("No current session is available in this context.");
  return session;
}

function unwrap<T>(response: { data?: T; error?: unknown }, label: string): T {
  if (response.error) throw response.error;
  if (response.data === undefined) throw new Error(`${label} returned no data.`);
  return response.data;
}

async function modelForScope(scope?: SessionActionScope): Promise<{ providerID?: string; modelID?: string }> {
  if (scope) {
    const directory = path.resolve(scope.directory);
    const topic = (await listTopicRuntimeStates()).find((candidate) => {
      if (candidate.settings.session?.id !== scope.sessionID) return false;
      const persistedDirectory = candidate.settings.session?.directory ?? candidate.settings.workspaceDirectory;
      return typeof persistedDirectory === "string" && path.resolve(persistedDirectory) === directory;
    });
    if (topic?.settings.model?.providerID && topic.settings.model.modelID) {
      return { providerID: topic.settings.model.providerID, modelID: topic.settings.model.modelID };
    }
  }
  return getStoredModel();
}

export async function listSessionTodos(scope?: SessionActionScope): Promise<unknown> {
  const session = await current(scope);
  return unwrap(await opencodeClient.session.todo({ sessionID: session.id, directory: session.directory }), "session.todo");
}
export async function listSessionDiff(scope?: SessionActionScope): Promise<unknown> {
  const session = await current(scope);
  return unwrap(await opencodeClient.session.diff({ sessionID: session.id, directory: session.directory }), "session.diff");
}
export async function listSessionChildren(scope?: SessionActionScope): Promise<unknown> {
  const session = await current(scope);
  return unwrap(await opencodeClient.session.children({ sessionID: session.id, directory: session.directory }), "session.children");
}
export async function forkCurrentSession(messageID: string, scope?: SessionActionScope): Promise<unknown> {
  const session = await current(scope);
  return unwrap(await opencodeClient.session.fork({ sessionID: session.id, messageID, directory: session.directory }), "session.fork");
}
export async function revertCurrentSession(messageID: string, scope?: SessionActionScope): Promise<unknown> {
  const session = await current(scope);
  return unwrap(await opencodeClient.session.revert({ sessionID: session.id, messageID, directory: session.directory }), "session.revert");
}
export async function unrevertCurrentSession(scope?: SessionActionScope): Promise<unknown> {
  const session = await current(scope);
  return unwrap(await opencodeClient.session.unrevert({ sessionID: session.id, directory: session.directory }), "session.unrevert");
}
export async function summarizeCurrentSession(scope?: SessionActionScope): Promise<unknown> {
  const session = await current(scope);
  const model = await modelForScope(scope);
  if (!model.providerID || !model.modelID) throw new Error("A concrete model must be selected before summarizing the session.");
  return unwrap(await opencodeClient.session.summarize({ sessionID: session.id, directory: session.directory, providerID: model.providerID, modelID: model.modelID }), "session.summarize");
}
export async function abortCurrentSession(scope?: SessionActionScope): Promise<unknown> {
  const session = await current(scope);
  return unwrap(await opencodeClient.session.abort({ sessionID: session.id, directory: session.directory }), "session.abort");
}