import os from "node:os";
import path from "node:path";
import { getRuntimeMode, type RuntimeMode } from "./mode.js";

export interface RuntimePaths {
  mode: RuntimeMode;
  appHome: string;
  envFilePath: string;
  /** @deprecated Compatibility alias for the bootstrap wizard; points to app-state.json. */
  settingsFilePath: string;
  logsDirPath: string;
  runDirPath: string;
}

const APP_DIR_NAME = "opencode-telegram-bot";

function getInstalledAppHome(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, APP_DIR_NAME);
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_DIR_NAME);
  }

  const xdgConfigHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdgConfigHome, APP_DIR_NAME);
}

function resolveAppHome(mode: RuntimeMode): string {
  const homeOverride = process.env.OPENCODE_TELEGRAM_HOME;
  if (homeOverride && homeOverride.trim().length > 0) {
    return path.resolve(homeOverride);
  }

  if (mode === "sources") {
    // Source-mode deployments may change process.cwd() while routing a topic.
    // Keep persistent application state anchored to the configured workspace.
    const persistentWorkspace = process.env.OPENCODE_TELEGRAM_WORKSPACE;
    if (persistentWorkspace && persistentWorkspace.trim().length > 0) {
      return path.resolve(persistentWorkspace);
    }
    return process.cwd();
  }

  return getInstalledAppHome();
}

function resolveOptionalPathOverride(envKey: string, fallbackPath: string): string {
  const override = process.env[envKey]?.trim();
  return override ? path.resolve(override) : fallbackPath;
}

export function getRuntimePaths(): RuntimePaths {
  const mode = getRuntimeMode();
  const appHome = resolveAppHome(mode);

  return {
    mode,
    appHome,
    envFilePath: path.join(appHome, ".env"),
    settingsFilePath: path.join(appHome, "app-state.json"),
    logsDirPath: resolveOptionalPathOverride("OPENCODE_TELEGRAM_LOGS_DIR", path.join(appHome, "logs")),
    runDirPath: resolveOptionalPathOverride("OPENCODE_TELEGRAM_RUN_DIR", path.join(appHome, "run")),
  };
}
