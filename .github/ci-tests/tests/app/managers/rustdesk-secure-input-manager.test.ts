import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseRustDeskSecureInputSignal,
  rustDeskSecureInputManager,
} from "../../../src/app/managers/rustdesk-secure-input-manager.js";

describe("rustdesk secure input manager", () => {
  beforeEach(() => {
    rustDeskSecureInputManager.__resetForTests();
    vi.useRealTimers();
  });

  it("parses only safe opaque RustDesk credential metadata", () => {
    expect(
      parseRustDeskSecureInputSignal({
        rustdeskSecureInput: {
          state: "required",
          credentialRequestId: "cred-1",
          connectionId: "conn-1",
          credentialKind: "rustdesk-password",
        },
      }),
    ).toEqual({
      state: "required",
      credentialRequestId: "cred-1",
      connectionId: "conn-1",
      credentialKind: "rustdesk-password",
    });
    expect(parseRustDeskSecureInputSignal({ rustdeskSecureInput: { state: "required" } })).toBeNull();
  });

  it("deduplicates repeated metadata and replaces a later challenge", () => {
    const first = rustDeskSecureInputManager.start({
      sessionId: "session-1",
      callId: "call-1",
      chatId: 42,
      credentialRequestId: "cred-1",
      connectionId: "conn-1",
      credentialKind: "rustdesk-password",
    });
    const duplicate = rustDeskSecureInputManager.start({
      sessionId: "session-1",
      callId: "call-1",
      chatId: 42,
      credentialRequestId: "cred-1",
      connectionId: "conn-1",
      credentialKind: "rustdesk-password",
    });
    const next = rustDeskSecureInputManager.start({
      sessionId: "session-1",
      callId: "call-1",
      chatId: 42,
      credentialRequestId: "cred-2",
      connectionId: "conn-1",
      credentialKind: "rustdesk-2fa",
    });

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(next.created).toBe(true);
    expect(rustDeskSecureInputManager.get("session-1")?.credentialRequestId).toBe("cred-2");
  });

  it("expires stale challenges without storing credential values", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T00:00:00Z"));
    const { challenge } = rustDeskSecureInputManager.start(
      {
        sessionId: "session-1",
        callId: "call-1",
        chatId: 42,
        credentialRequestId: "cred-1",
        connectionId: "conn-1",
      },
      1_000,
    );

    expect(Object.keys(challenge)).not.toContain("credential");
    vi.advanceTimersByTime(1_001);
    expect(rustDeskSecureInputManager.get("session-1")).toBeNull();
  });
});
