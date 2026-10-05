import { createInfrastructureClient } from "./railway-client.js";
import { lstat } from "node:fs/promises";
import { constants } from "node:os";

// This process is the only infrastructure credential owner. Railway starts it as
// root; the existing bootstrap drops the Bot and Core to the node user. The
// credential never enters the shell, application, or runtime environment.
const infrastructure = createInfrastructureClient(process.env);

async function main(): Promise<void> {
  if (process.getuid?.() !== 0) throw new Error("Infrastructure launcher requires a separate privileged identity");
  const { budgetedSpawn, budgetedExecFile } = await import("../runtime/process-budget.js");
  const volume = await lstat("/data");
  if (!volume.isDirectory() || volume.isSymbolicLink()) throw new Error("Invalid persistent volume root");
  // Only the mount root needs ownership preparation. Never traverse or execute
  // application-controlled persistent files as the credential-owning identity.
  await budgetedExecFile("cleanup", "/usr/bin/chown", ["--no-dereference", "1000:1000", "/data"]);
  const child = await budgetedSpawn("bot-daemon", "/app/railway-volume-maintenance.sh", [], {
    cwd: "/app",
    stdio: "inherit",
    uid: 1000,
    gid: 1000,
  });
  process.stdout.write("[InfrastructureBoundary] startup_environment_isolated application_uid=node\n");
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => { child.kill(signal); });
  }
  child.once("error", () => {
    infrastructure.dispose();
    process.stderr.write("[InfrastructureBoundary] application_start_failed\n");
    process.exit(1);
  });
  child.once("close", (code, signal) => {
    infrastructure.dispose();
    process.exit(code ?? (signal ? 128 + constants.signals[signal] : 1));
  });
}

void main().catch(() => {
  infrastructure.dispose();
  process.stderr.write("[InfrastructureBoundary] launcher_failed\n");
  process.exit(1);
});
