import { describe, expect, it } from "vitest";

import {
  containsForcePushFlag,
  isSensitivePath,
  parseShellLikeArgs,
} from "../../../src/app/services/agent-tool-support-service.js";

describe("parseShellLikeArgs", () => {
  it("splits plain arguments on whitespace", () => {
    expect(parseShellLikeArgs("HEAD~1 --stat")).toEqual(["HEAD~1", "--stat"]);
  });

  it("preserves backslashes that are not escaping anything inside quotes", () => {
    expect(parseShellLikeArgs("src\\file.ts")).toEqual(["src\\file.ts"]);
  });

  it("keeps single-quoted segments literal", () => {
    expect(parseShellLikeArgs("'a b' --c")).toEqual(["a b", "--c"]);
  });

  it("supports double-quoted segments and escaped quotes", () => {
    expect(parseShellLikeArgs('"a \\"b\\"" --c')).toEqual(['a "b"', "--c"]);
  });

  it("rejects an unclosed quote instead of guessing", () => {
    expect(() => parseShellLikeArgs('"unterminated')).toThrow(/unclosed quote/i);
  });
});

describe("containsForcePushFlag", () => {
  it("detects long force flags", () => {
    expect(containsForcePushFlag(["origin", "main", "--force"])).toBe(true);
    expect(containsForcePushFlag(["origin", "main", "--force-with-lease"])).toBe(true);
  });

  it("detects the short force flag", () => {
    expect(containsForcePushFlag(["origin", "main", "-f"])).toBe(true);
  });

  it("returns false for a normal push", () => {
    expect(containsForcePushFlag(["origin", "main"])).toBe(false);
  });
});

describe("isSensitivePath", () => {
  it("flags environment and credential files", () => {
    expect(isSensitivePath(".env")).toBe(true);
    expect(isSensitivePath(".env.production")).toBe(true);
    expect(isSensitivePath("config/credentials.json")).toBe(true);
    expect(isSensitivePath("certs/server.pem")).toBe(true);
    expect(isSensitivePath("keys/id_rsa")).toBe(true);
  });

  it("does not flag ordinary source files", () => {
    expect(isSensitivePath("src/index.ts")).toBe(false);
    expect(isSensitivePath("README.md")).toBe(false);
  });
});