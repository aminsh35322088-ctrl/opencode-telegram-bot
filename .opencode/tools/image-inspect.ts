import type { ToolProcessPort } from "@opencode-telegram/native-runtime";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";


export default tool({
  description: "Inspect image format, dimensions, color space, and file metadata through the explicit inspect action. This tool cannot see or describe image contents and is not a substitute for native multimodal image input.",
  args: {
    action: tool.schema.enum(["inspect"]).describe("Image metadata action to execute."),
    path: tool.schema.string().describe("Image path, absolute or relative to the worktree."),
  },
  async execute(args, context) {
    const processPort = (context as typeof context & { process?: ToolProcessPort }).process;
    if (!processPort) throw new Error("Core process capability is required for tool ownership.");
    const base = context.directory || context.worktree || process.cwd();
    const image = path.isAbsolute(args.path) ? args.path : path.resolve(base, args.path);
    try {
      const { stdout, stderr } = await processPort.execFile("identify", ["-verbose", image], { cwd: context.directory || context.worktree, signal: context.abort, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
      const wanted = stdout.split(/\r?\n/).filter((line) => /^(\s*(Format|Geometry|Colorspace|Depth|Filesize|Mime type|Type):)/i.test(line));
      return `${wanted.join("\n")}${stderr.trim() ? `\n${stderr.trim()}` : ""}`.slice(0, 8000);
    } catch (error) {
      const e = error as { stderr?: string; message?: string };
      throw new Error(e.stderr || e.message || `Unable to inspect image: ${image}`);
    }
  },
});
