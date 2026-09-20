import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { tool } from "@opencode-ai/plugin";

const execFileAsync = promisify(execFile);

async function runCommand(cmd: string, args: string[], worktree: string, timeout = 60000): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: worktree,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim() || stderr.trim();
  } catch (error) {
    const e = error as { stderr?: string; message?: string; code?: string | number };
    if (e.code === "ENOENT") throw new Error(`${cmd} is not installed. Install it first.`);
    throw new Error(e.stderr || e.message || `Command failed: ${cmd}`);
  }
}

export default tool({
  description: "Security operations: scan for secrets, audit dependencies, check file permissions.",
  args: {
    action: tool.schema.enum(["secrets", "audit", "permissions", "deps"]).describe("Security action to execute."),
    path: tool.schema.string().optional().describe("Path to scan (defaults to worktree root)."),
  },
  async execute(args, context) {
    const { action, path: scanPath } = args;
    const worktree = context.worktree;
    const target = scanPath ? path.resolve(worktree, scanPath) : worktree;

    switch (action) {
      case "secrets": {
        const patterns = [
          { name: "AWS Key", regex: /AKIA[0-9A-Z]{16}/g },
          { name: "Private Key", regex: /-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----/g },
          { name: "Password", regex: /password\s*[:=]\s*['"][^'"]+['"]/gi },
          { name: "Token", regex: /token\s*[:=]\s*['"][^'"]+['"]/gi },
          { name: "API Key", regex: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/gi },
          { name: "Secret", regex: /secret\s*[:=]\s*['"][^'"]+['"]/gi },
        ];

        const findings: string[] = [];
        const walk = async (dir: string): Promise<void> => {
          try {
            const items = await fs.readdir(dir, { withFileTypes: true });
            for (const item of items) {
              if (item.name.startsWith(".") || item.name === "node_modules") continue;
              const itemPath = path.join(dir, item.name);
              if (item.isDirectory()) {
                await walk(itemPath);
              } else if (item.isFile()) {
                try {
                  const content = await fs.readFile(itemPath, "utf-8");
                  for (const { name, regex } of patterns) {
                    const matches = content.match(regex);
                    if (matches) {
                      findings.push(`${path.relative(worktree, itemPath)}: ${name} (${matches.length} occurrences)`);
                    }
                  }
                } catch {}
              }
            }
          } catch {}
        };

        await walk(target);
        return findings.length
          ? `Found ${findings.length} potential secrets:\n${findings.join("\n")}`
          : "No secrets found";
      }
      case "audit": {
        try {
          const output = await runCommand("npm", ["audit", "--json"], worktree);
          const audit = JSON.parse(output);
          const vuln = audit.metadata?.vulnerabilities || {};
          const summary = [
            vuln.critical ? `Critical: ${vuln.critical}` : "",
            vuln.high ? `High: ${vuln.high}` : "",
            vuln.moderate ? `Moderate: ${vuln.moderate}` : "",
            vuln.low ? `Low: ${vuln.low}` : "",
          ].filter(Boolean).join(", ");
          return summary || "No vulnerabilities found";
        } catch {
          return "npm audit not available. Run manually: npm audit";
        }
      }
      case "permissions": {
        try {
          const { stdout } = await execFileAsync("find", [target, "-type", "f", "-perm", "/111", "-not", "-path", "*/node_modules/*"], {
            cwd: worktree,
            timeout: 30000,
          });
          const files = stdout.trim().split("\n").filter(Boolean);
          return files.length
            ? `Found ${files.length} executable files:\n${files.slice(0, 20).join("\n")}${files.length > 20 ? "\n..." : ""}`
            : "No executable files found";
        } catch {
          return "Permission check not available";
        }
      }
      case "deps": {
        try {
          const output = await runCommand("npm", ["outdated", "--json"], worktree);
          const outdated = JSON.parse(output);
          const deps = Object.entries(outdated).map(([name, info]: [string, any]) =>
            `${name}: ${info.current} -> ${info.latest}`
          );
          return deps.length
            ? `Found ${deps.length} outdated dependencies:\n${deps.slice(0, 20).join("\n")}${deps.length > 20 ? "\n..." : ""}`
            : "All dependencies are up to date";
        } catch {
          return "npm outdated not available";
        }
      }
      default:
        throw new Error(`Unknown security action: ${action}`);
    }
  },
});
