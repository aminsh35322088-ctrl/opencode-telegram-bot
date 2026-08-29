import { promises as fs } from "node:fs";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";

const MARKER = "__TELEGRAM_ARTIFACT__";
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const SENSITIVE_SEGMENTS = new Set([".ssh", ".aws", ".azure", ".gnupg"]);

function isSensitive(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/").toLowerCase();
  const basename = path.basename(normalized);
  const segments = normalized.split("/");

  if (segments.some((segment) => SENSITIVE_SEGMENTS.has(segment))) return true;
  if (basename === ".env" || basename.startsWith(".env.")) return true;
  if (basename === "credentials" || basename === "credentials.json") return true;
  if (basename.endsWith(".pem") || basename.endsWith(".key")) return true;
  if (basename === "id_rsa" || basename === "id_ed25519") return true;
  return false;
}

export default tool({
  description:
    "Send a real file/artifact to the user through the Telegram bridge. Use this when the user explicitly asks to receive a generated file, archive, website, image, document, build artifact, or other output file. The file can be any format; do not rename or convert it just to satisfy an extension list. For multi-file projects, create a real archive first, verify it, then call this tool with the archive path.",
  args: {
    path: tool.schema.string().describe("Absolute or working-directory-relative path of the file to send."),
    caption: tool.schema.string().optional().describe("Optional short Telegram caption."),
  },
  async execute(args, context) {
    const filePath = path.isAbsolute(args.path)
      ? path.normalize(args.path)
      : path.resolve(context.worktree, args.path);

    if (isSensitive(filePath)) {
      throw new Error("Refusing to send a sensitive or credential-like file.");
    }

    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(`File does not exist or is not a regular file: ${filePath}`);
    }
    if (stat.size === 0) {
      throw new Error(`Refusing to send an empty file: ${filePath}`);
    }
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      throw new Error(`File is larger than the Telegram 50 MB upload limit: ${filePath}`);
    }

    const caption = args.caption?.trim();
    const marker = `${MARKER} ${filePath}`;
    return {
      title: `Send ${path.basename(filePath)}`,
      output: caption ? `${marker}\n${caption}` : marker,
    };
  },
});
