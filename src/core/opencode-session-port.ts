import {
  TemporarySessionRunner,
  type TemporarySessionPort,
} from "@opencode-telegram/native-runtime";
import { opencodeClient } from "../opencode/client.js";
import { markAbortExpected } from "../app/managers/abort-suppression-manager.js";

export function createOpenCodeTemporarySessionPort(): TemporarySessionPort {
  return {
    async get(owner, signal) {
      const { data, error } = await opencodeClient.session.get(
        { sessionID: owner.sessionId, directory: owner.directory },
        { signal },
      );
      if (error || !data) throw new Error("OpenCode could not verify the temporary session owner");
      return { sessionId: data.id, directory: data.directory };
    },
    async create(owner, options, signal) {
      const { data, error } = await opencodeClient.session.create(
        {
          directory: owner.directory,
          parentID: owner.sessionId,
          ...options,
        },
        { signal },
      );
      if (error || !data) throw new Error("OpenCode could not create a temporary session");
      return {
        sessionId: data.id,
        directory: data.directory,
        parentSessionId: data.parentID ?? "",
      };
    },
    async abort(session, signal) {
      markAbortExpected(session.sessionId);
      const { data, error } = await opencodeClient.session.abort(
        { sessionID: session.sessionId, directory: session.directory },
        { signal },
      );
      if (error || data !== true)
        throw new Error("OpenCode did not confirm the owned session abort");
    },
    async remove(session, signal) {
      const { data, error } = await opencodeClient.session.delete(
        { sessionID: session.sessionId, directory: session.directory },
        { signal },
      );
      if (error || data !== true)
        throw new Error("OpenCode did not confirm temporary session cleanup");
    },
  };
}

export function createOpenCodeTemporarySessionRunner(): TemporarySessionRunner {
  return new TemporarySessionRunner(createOpenCodeTemporarySessionPort());
}
