import { describe, expect, it } from "vitest";
import { __test } from "../../../src/app/services/free-source-browser-bootstrap.js";

describe("Qwen guest browser bootstrap", () => {
  it("builds a bounded browser capture script for Qwen Baxia headers", () => {
    const script = __test.captureScript();
    expect(script).toContain("https://chat.qwen.ai");
    expect(script).toContain("bx-ua");
    expect(script).toContain("bx-umidtoken");
    expect(script).toContain("bx-v");
    expect(script).toContain("/api/v2/chats/new");
    expect(script).toContain("__OTB_QWEN_BX__");
  });

  it("parses raw Playwright output using the private result marker", () => {
    const payload = {
      captured: { bxUA: "ua", bxUmidToken: "umid", bxV: "2.5.37" },
      verified: true,
      status: 200,
    };
    const output = "noise before\n__OTB_QWEN_BX__" + JSON.stringify(payload) + "\n";
    expect(__test.parseCaptureOutput(output)).toEqual(payload);
  });

  it("decodes the JSON-string wrapper emitted by playwright-cli run-code", () => {
    const payload = {
      captured: { bxUA: "ua", bxUmidToken: "umid", bxV: "2.5.37" },
      verified: true,
      status: 200,
    };
    const wrapped = JSON.stringify("__OTB_QWEN_BX__" + JSON.stringify(payload));
    expect(__test.parseCaptureOutput(wrapped)).toEqual(payload);
  });

  it("rejects Playwright output without the expected result marker", () => {
    expect(() => __test.parseCaptureOutput("unexpected output")).toThrow(
      "Playwright did not return a Qwen capture payload",
    );
  });
});
