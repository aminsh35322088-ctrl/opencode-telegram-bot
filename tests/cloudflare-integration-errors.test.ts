import assert from "node:assert/strict";
import { test } from "node:test";
import { integrationFailureNotice, integrationFailureCategory } from "../src/cloudflare/integration-errors.js";

test("integration errors offer specific recovery without reflecting arbitrary exception material", () => {
  assert.match(integrationFailureNotice(new Error("integration_unauthorized"))!, /rejected/);
  assert.match(integrationFailureNotice(new Error("tailscale_api_token_required"))!, /API access token/);
  assert.match(integrationFailureNotice(new Error("integration_unavailable"))!, /unavailable/);
  assert.match(integrationFailureNotice(new Error("insufficient_write_permission"))!, /write permission/);
  assert.match(integrationFailureNotice(new Error("railway_unauthorized"))!, /Railway authorization expired/i);
  assert.match(integrationFailureNotice(new Error("railway_forbidden"))!, /Railway credential/i);
  for (const error of [new Error("constructor"), new Error("__proto__"), new Error("fixture-private-token"), new Error("integration_unauthorized fixture-private-token"), null])
    assert.equal(integrationFailureNotice(error), undefined);
});

test("diagnostic categories never contain upstream messages or credential material", () => {
  assert.equal(integrationFailureCategory(new Error("integration_unauthorized")), "integration_unauthorized");
  assert.equal(integrationFailureCategory(new Error("railway_unauthorized")), "railway_unauthorized");
  for (const error of [new Error("synthetic_secret"), new Error("integration_unauthorized synthetic_secret"), null])
    assert.equal(integrationFailureCategory(error), "operation_failed");
});
