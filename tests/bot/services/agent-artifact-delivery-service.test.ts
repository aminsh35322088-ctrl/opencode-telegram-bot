import { describe, expect, it } from "vitest";
import {
  extractArtifactMarkers,
  isLikelyArtifactFromFileEvent,
  isSensitiveArtifactPath,
} from "../../../src/bot/services/agent-artifact-delivery-service.js";

describe("agent artifact delivery", () => {
  it("extracts explicit delivery markers without an extension whitelist", () => {
    expect(
      extractArtifactMarkers(
        "__TELEGRAM_ARTIFACT__ /tmp/site.zip\n__TELEGRAM_ARTIFACT__ /tmp/custom.binary",
      ),
    ).toEqual(["/tmp/site.zip", "/tmp/custom.binary"]);
  });

  it("recognizes binary artifacts regardless of extension", () => {
    const zipHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
    expect(isLikelyArtifactFromFileEvent("/tmp/site.custom", zipHeader)).toBe(true);
  });

  it("does not require a known extension for generated text artifacts", () => {
    expect(isLikelyArtifactFromFileEvent("/tmp/generated.output", Buffer.from("hello"))).toBe(true);
  });

  it("does not auto-deliver arbitrary source edits", () => {
    expect(isLikelyArtifactFromFileEvent("/workspace/src/index.ts", Buffer.from("export const x = 1;"))).toBe(false);
  });

  it("blocks sensitive files", () => {
    expect(isSensitiveArtifactPath("/home/app/.ssh/id_ed25519")).toBe(true);
    expect(isSensitiveArtifactPath("/workspace/.env.production")).toBe(true);
    expect(isSensitiveArtifactPath("/workspace/report.pdf")).toBe(false);
  });
});
