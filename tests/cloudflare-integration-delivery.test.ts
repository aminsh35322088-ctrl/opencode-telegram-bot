import assert from "node:assert/strict";
import { test } from "node:test";
import { integrationDelivery } from "../src/cloudflare/integration-delivery.js";
import type { CredentialRequest } from "../src/cloudflare/capability-broker.js";
const request = {
  integrationId: "github",
  capability: "repo.read",
  resource: "owner/repository",
  scopes: ["repo.read"],
  credentialId: crypto.randomUUID(),
  workerId: "worker",
  topicId: "-100:42",
  generation: 1,
  sessionId: "session",
} satisfies CredentialRequest;
test("GitHub checks selected repository and actual Git read/write transport permission", async () => {
  for (const capability of ["repo.read", "repo.write"]) {
    const urls: string[] = [];
    const deliver = integrationDelivery(async (url, options) => {
      urls.push(String(url));
      assert.ok(options?.signal);
      assert.equal(options?.redirect, "manual");
      return String(url).startsWith("https://api.github.com")
        ? Response.json({ private: true })
        : new Response("refs", {
            headers: {
              "Content-Type":
                "application/x-git-" +
                (capability === "repo.read" ? "upload" : "receive") +
                "-pack-advertisement",
            },
          });
    });
    assert.equal(await deliver("private-token", { ...request, capability }), "private-token");
    assert.equal(urls[0], "https://api.github.com/repos/owner/repository");
    assert.match(urls[1]!, capability === "repo.read" ? /git-upload-pack$/ : /git-receive-pack$/);
  }
});
test("GitHub permission failures expose stable categories without upstream token echoes", async () => {
  for (const [status, expected] of [
    [401, "credential_revoked"],
    [403, "repository_not_authorized"],
    [404, "repository_unavailable"],
  ] as const) {
    await assert.rejects(
      integrationDelivery(async () => new Response("private-token", { status }))(
        "private-token",
        request,
      ),
      new RegExp("^Error: " + expected + "$"),
    );
  }
  let n = 0;
  await assert.rejects(
    integrationDelivery(async () =>
      ++n === 1 ? Response.json({}) : new Response("private-token", { status: 403 }),
    )("private-token", { ...request, capability: "repo.write" }),
    /^Error: insufficient_write_permission$/,
  );
  await assert.rejects(
    integrationDelivery(async () => {
      throw new Error("private-token");
    })("private-token", request),
    /^Error: integration_unavailable$/,
  );
});
test("Tailscale management credential mints one Worker enrollment key without returning management material", async () => {
  const deliver = integrationDelivery(async (url, options) => {
    assert.equal(url, "https://api.tailscale.com/api/v2/tailnet/-/keys");
    assert.equal(
      new Headers(options?.headers).get("Authorization"),
      "Bearer tskey-api-private-management",
    );
    const body = JSON.parse(String(options?.body));
    assert.equal(body.expirySeconds, 300);
    assert.equal(body.capabilities.devices.create.reusable, false);
    assert.equal(body.capabilities.devices.create.ephemeral, false);
    assert.deepEqual(body.capabilities.devices.create.tags, ["tag:opencode-bot"]);
    return Response.json({ key: "tskey-auth-private-enrollment" });
  });
  assert.equal(
    await deliver("tskey-api-private-management", {
      ...request,
      integrationId: "tailscale",
      capability: "device.enroll",
      resource: undefined,
    }),
    "tskey-auth-private-enrollment",
  );
  await assert.rejects(
    deliver("tskey-api-private-management", {
      ...request,
      integrationId: "tailscale",
      capability: "ssh.exec",
    }),
    /credential_scope_rejected/,
  );
});
test("malformed resources and management responses fail closed before credential delivery", async () => {
  const deliver = integrationDelivery(async () => {
    assert.fail("must not fetch");
  });
  for (const resource of [
    "https://evil.example/repo",
    "owner/repo?x",
    "../repository",
    "owner/repo/other",
  ])
    await assert.rejects(deliver("private-token", { ...request, resource }), /invalid_repository/);
  await assert.rejects(
    integrationDelivery(async () => Response.json({ key: "tskey-api-private-management" }))(
      "tskey-api-private-management",
      { ...request, integrationId: "tailscale", capability: "device.enroll" },
    ),
    /integration_invalid_response/,
  );
});
