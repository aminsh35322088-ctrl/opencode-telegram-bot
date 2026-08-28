import type { CommandContext, Context } from "grammy";
import { addMemory, formatMemoryList, listMemories, removeMemory } from "../../app/services/memory-service.js";
import { getCurrentProject } from "../../app/stores/settings-store.js";

function getArgument(ctx: CommandContext<Context>): string {
  return typeof ctx.match === "string" ? ctx.match.trim() : "";
}

export async function memoryCommand(ctx: CommandContext<Context>): Promise<void> {
  const project = getCurrentProject();
  const memories = await listMemories(undefined, project?.id);

  await ctx.reply(
    `🧠 Persistent memory\n\n${formatMemoryList(memories)}\n\n` +
      "Use /remember <text> to save a user memory.\n" +
      "Use /remember project <text> to save project memory.\n" +
      "Use /forget <id> to remove a memory.",
  );
}

export async function rememberCommand(ctx: CommandContext<Context>): Promise<void> {
  const argument = getArgument(ctx);
  if (!argument) {
    await ctx.reply("Usage: /remember <text> or /remember project <text>");
    return;
  }

  const project = getCurrentProject();
  const projectPrefix = "project ";
  const isProjectMemory = argument.toLowerCase().startsWith(projectPrefix);
  const content = isProjectMemory ? argument.slice(projectPrefix.length).trim() : argument;

  try {
    const input: {
      scope: "user" | "project";
      content: string;
      projectId?: string | undefined;
      projectDirectory?: string | undefined;
    } = {
      scope: isProjectMemory ? "project" : "user",
      content,
    };

    if (project?.id) input.projectId = project.id;
    if (project?.worktree) input.projectDirectory = project.worktree;

    const memory = await addMemory(input);
    await ctx.reply(`✅ Memory saved (${memory.scope}).\n\n${memory.content}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save memory";
    await ctx.reply(`❌ ${message}`);
  }
}

export async function forgetCommand(ctx: CommandContext<Context>): Promise<void> {
  const id = getArgument(ctx);
  if (!id) {
    await ctx.reply("Usage: /forget <memory-id>");
    return;
  }

  const removed = await removeMemory(id);
  await ctx.reply(removed ? "✅ Memory removed." : "⚠️ Memory not found.");
}
