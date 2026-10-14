import { readdirSync } from "node:fs";
import { join } from "node:path";

// Topic workspaces are stored as topic-workspaces/<chatId>/<sessionId>.
// Count session directories rather than the chat grouping directories.
export function countTopicWorkspaces(workspaceDir) {
  try {
    const chatDirectories = readdirSync(workspaceDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^-?\d+$/.test(entry.name));
    return chatDirectories.reduce((total, chat) => {
      const sessions = readdirSync(join(workspaceDir, chat.name), { withFileTypes: true });
      return total + sessions.filter((entry) => entry.isDirectory()).length;
    }, 0);
  } catch {
    return null;
  }
}
