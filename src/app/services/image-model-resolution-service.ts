import path from "node:path";
import { readAppState } from "../stores/app-state-store.js";
import { listTopicRuntimeStates } from "../stores/topic-runtime-state-store.js";
import {
  normalizeImageModelSelection,
  type ImageModelSelection,
} from "../types/image-model.js";

function sameDirectory(left: string | undefined, right: string): boolean {
  if (!left) return false;
  return path.resolve(left) === path.resolve(right);
}

function globalDefaultFromState(
  state: Awaited<ReturnType<typeof readAppState>>,
): ImageModelSelection | undefined {
  const settings = state.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return undefined;
  return normalizeImageModelSelection(
    (settings as Record<string, unknown>).defaultImageModel,
  );
}

export async function resolvePersistedImageModel(
  worktree?: string,
): Promise<ImageModelSelection | undefined> {
  const [state, topics] = await Promise.all([
    readAppState(),
    worktree ? listTopicRuntimeStates() : Promise.resolve([]),
  ]);
  const globalDefault = globalDefaultFromState(state);
  if (!worktree) return globalDefault;

  const topic = topics.find((candidate) =>
    sameDirectory(candidate.settings.workspaceDirectory, worktree)
    || sameDirectory(candidate.settings.session?.directory, worktree));

  return normalizeImageModelSelection(topic?.settings.imageModelOverride)
    ?? globalDefault;
}
