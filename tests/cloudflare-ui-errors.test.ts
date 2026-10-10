import assert from "node:assert/strict";
import { test } from "node:test";
import { uiValidationNotice } from "../src/cloudflare/ui-errors.js";
test("ordinary Main configuration failures provide bounded recovery without reflecting input", () => {
  for (const code of [
    "invalid_configuration_json",
    "invalid_configuration_id",
    "configuration_draft_expired",
    "configuration_revision_changed",
    "memory_missing",
    "invalid_model_search",
    "model_provider_unavailable",
    "use_protected_credential_reference",
    "control_reset_pending",
  ]) {
    const notice = uiValidationNotice(new Error(code));
    assert.ok(notice, code);
    assert.doesNotMatch(notice, /The operation could not be completed/);
  }
  for (const code of [
    "constructor",
    "__proto__",
    "private-key",
    "invalid_configuration_json private-key",
  ])
    assert.equal(uiValidationNotice(new Error(code)), undefined);
});
