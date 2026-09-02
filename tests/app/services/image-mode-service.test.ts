import { afterEach, describe, expect, it } from "vitest";
import { activateImageMode, clearImageMode, isImageModeActive } from "../../../src/app/services/image-mode-service.js";

afterEach(() => clearImageMode());

describe("image mode", () => {
  it("is inactive by default", () => {
    expect(isImageModeActive()).toBe(false);
  });

  it("activates explicitly and can be cleared", () => {
    activateImageMode();
    expect(isImageModeActive()).toBe(true);
    clearImageMode();
    expect(isImageModeActive()).toBe(false);
  });
});
