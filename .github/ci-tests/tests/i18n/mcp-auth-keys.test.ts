import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { en, type I18nKey } from "../../src/i18n/en.js";
import { ar } from "../../src/i18n/ar.js";
import { de } from "../../src/i18n/de.js";
import { es } from "../../src/i18n/es.js";
import { fr } from "../../src/i18n/fr.js";
import { it as itLocale } from "../../src/i18n/it.js";
import { ko } from "../../src/i18n/ko.js";
import { pt } from "../../src/i18n/pt.js";
import { ru } from "../../src/i18n/ru.js";
import { zh } from "../../src/i18n/zh.js";
import { t, setRuntimeLocale, resetRuntimeLocale } from "../../src/i18n/index.js";
import { buildMcpsDetailText } from "../../src/bot/menus/mcp-server-menu.js";

const REQUIRED_KEYS = [
  "mcps.detail.needs_auth_hint",
  "mcps.detail.needs_client_registration_hint",
  "mcps.auth.sign_in_title",
  "mcps.auth.sign_in_steps",
  "mcps.auth.cancelled",
  "mcps.auth.login_cancelled",
  "mcps.auth.setup_cancelled",
  "mcps.auth.not_waiting_oauth",
  "mcps.auth.opening_login",
  "mcps.auth.menu_title",
  "mcps.auth.menu_prompt",
  "mcps.auth.menu_options",
  "mcps.auth.secrets_note",
  "mcps.auth.outside_context",
  "mcps.auth.header_name_prompt",
  "mcps.auth.bearer_prompt",
  "mcps.auth.api_key_prompt",
  "mcps.auth.custom_header_prompt",
  "mcps.auth.client_id_prompt",
  "mcps.auth.client_secret_prompt",
  "mcps.auth.scope_prompt",
  "model.fallback.notice",
] as const satisfies readonly I18nKey[];

const LOCALES: Record<string, Record<string, string>> = {
  en,
  ar,
  de,
  es,
  fr,
  it: itLocale,
  ko,
  pt,
  ru,
  zh,
};

describe("MCP auth and model fallback i18n keys", () => {
  it("defines every required key in every locale", () => {
    const missing: string[] = [];
    for (const [code, dictionary] of Object.entries(LOCALES)) {
      for (const key of REQUIRED_KEYS) {
        if (!(key in dictionary) || !dictionary[key]?.trim()) missing.push(`${code}:${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("does not leave the obsolete mcps.auth_required key defined", () => {
    for (const [code, dictionary] of Object.entries(LOCALES)) {
      expect("mcps.auth_required" in dictionary, `${code} still defines mcps.auth_required`).toBe(false);
    }
  });

  it("renders MCP needs_auth detail text from the i18n dictionary", () => {
    resetRuntimeLocale();
    const server = { name: "oauth-server", status: { status: "needs_auth" as const } };
    expect(buildMcpsDetailText(server as never)).toContain(t("mcps.detail.needs_auth_hint"));

    setRuntimeLocale("ar");
    try {
      expect(buildMcpsDetailText(server as never)).toContain(ar["mcps.detail.needs_auth_hint"]);
      expect(buildMcpsDetailText(server as never)).not.toContain(en["mcps.detail.needs_auth_hint"]);
    } finally {
      resetRuntimeLocale();
    }
  });

  it("keeps callback answer strings within the Telegram 200-char limit", () => {
    const answerKeys = [
      "mcps.auth.cancelled",
      "mcps.auth.login_cancelled",
      "mcps.auth.setup_cancelled",
      "mcps.auth.not_waiting_oauth",
      "mcps.auth.opening_login",
    ] as const;
    for (const [code, dictionary] of Object.entries(LOCALES)) {
      for (const key of answerKeys) {
        expect(dictionary[key].length, `${code}:${key}`).toBeLessThanOrEqual(200);
      }
    }
  });

  it("source files route MCP auth user-facing strings through t()", () => {
    const root = path.resolve(__dirname, "../../src/bot");
    const files = [
      path.join(root, "menus/mcp-server-menu.ts"),
      path.join(root, "callbacks/mcp-server-callback-handler.ts"),
      path.join(root, "commands/mcp-server-command.ts"),
    ];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      expect(source).not.toMatch(/Authentication setup cancelled\.|Opening secure MCP login|not waiting for OAuth login|Choose how this remote MCP server|Credentials stay outside model context|OAuth login is required\. Tap Sign In/);
      // Hardcoded English OAuth detail lines must be gone (replaced by keys).
      if (file.endsWith("mcp-server-menu.ts")) {
        expect(source).not.toContain("Tap Sign In below to authorize");
        expect(source).toContain("mcps.detail.needs_auth_hint");
      }
      if (file.endsWith("mcp-server-callback-handler.ts")) {
        expect(source).toContain('t("mcps.auth.cancelled")');
        expect(source).toContain('t("mcps.auth.opening_login")');
        expect(source).toContain('t("mcps.auth.not_waiting_oauth")');
      }
      if (file.endsWith("mcp-server-command.ts")) {
        expect(source).toContain('t("mcps.auth.menu_prompt")');
        expect(source).toContain('t("mcps.auth.bearer_prompt")');
        expect(source).toContain('t("mcps.auth.outside_context")');
      }
    }
  });
});
