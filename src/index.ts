import { resolveRuntimeMode, setRuntimeMode } from "./runtime/mode.js";
import { getUnsupportedNodeVersionMessage } from "./runtime/node-version.js";

const EXIT_RUNTIME_ERROR = 1;
const EXIT_INVALID_ARGS = 2;
const LOG_FLUSH_TIMEOUT_MS = 1000;

async function main(): Promise<void> {
  const unsupportedNodeVersion = getUnsupportedNodeVersionMessage();

  if (unsupportedNodeVersion) {
    process.stderr.write(`${unsupportedNodeVersion}\n`);
    process.exit(EXIT_RUNTIME_ERROR);
    return;
  }

  const modeResult = resolveRuntimeMode({
    defaultMode: "sources",
    argv: process.argv.slice(2),
  });

  if (modeResult.error) {
    process.stderr.write(`${modeResult.error}\n`);
    process.exit(EXIT_INVALID_ARGS);
    return;
  }

  setRuntimeMode(modeResult.mode);

  const { initializeLogger } = await import("./utils/logger.js");
  await initializeLogger();
  const {recoverInterruptedGlobalMutationApprovals}=await import("./control-plane/mutations.js");
  await recoverInterruptedGlobalMutationApprovals();
  const {installControlApplicationChannel}=await import("./control-plane/application-channel.js");
  installControlApplicationChannel();
  if(process.env.CONTROL_APPLICATION_IPC==="1" && process.env.TOPIC_NODE_CREATION_ENABLED==="1"){
    const {setTopicNodeCreationEnabled}=await import("./control-plane/topic-node-lifecycle.js");
    setTopicNodeCreationEnabled(true);
  }

  const { startBotApp } = await import("./app/bootstrap/start-bot-app.js");
  await startBotApp();
}

void main().catch(async (error: unknown) => {
  if (error instanceof Error) {
    process.stderr.write(`Failed to start bot: ${error.message}\n`);
  } else {
    process.stderr.write(`Failed to start bot: ${String(error)}\n`);
  }

  // The file log is initialized by now; give buffered lines a bounded chance
  // to reach the file before the exit. A failed flush must not defeat the exit.
  const { flushLogger } = await import("./utils/logger.js");
  await Promise.race([
    flushLogger().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, LOG_FLUSH_TIMEOUT_MS)),
  ]);
  process.exit(EXIT_RUNTIME_ERROR);
});
