import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Extension auth routing invariants", () => {
  it("redacts OAuth transport details from the model-facing add result", async () => {
    const source = await fs.readFile(".opencode/tools/bot.ts", "utf8");
    const helperStart = source.indexOf("function modelSafeExtensionAddResult");
    const helperEnd = source.indexOf("function expandMinuteBase", helperStart);
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    const helper = source.slice(helperStart, helperEnd);

    expect(helper).not.toContain("authorizationUrl");
    expect(helper).not.toContain("oauthState");
    expect(source).toContain("json(modelSafeExtensionAddResult(await ensure.addMcpBackedExtension");
  });

  it("presents session-routed Extension auth UI before the global current-session gate", async () => {
    const source = await fs.readFile("src/bot/services/event-subscription-service.ts", "utf8");
    const rootTool = source.indexOf("summaryAggregator.setOnRootToolUpdate");
    const presenter = source.indexOf("presentPendingExtensionAutomation(", rootTool);
    const globalGate = source.indexOf("const currentSession = getCurrentSession()", rootTool);

    expect(rootTool).toBeGreaterThanOrEqual(0);
    expect(presenter).toBeGreaterThan(rootTool);
    expect(globalGate).toBeGreaterThan(presenter);
  });

  it("intercepts secure/OAuth callback text before normal prompt routing", async () => {
    const source = await fs.readFile("src/bot/routers/message-router.ts", "utf8");
    const textRoute = source.indexOf('bot.on("message:text"');
    const secureIntercept = source.indexOf("handleSecureExtensionMessage(ctx)", textRoute);
    const promptLog = source.indexOf("[Bot] Received text message", textRoute);

    expect(textRoute).toBeGreaterThanOrEqual(0);
    expect(secureIntercept).toBeGreaterThan(textRoute);
    expect(promptLog).toBeGreaterThan(secureIntercept);
  });
});
