import type { CredentialRequest } from "./capability-broker.js";

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
async function json(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("integration_invalid_response");
  const reader = response.body.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 1024 * 1024) throw new Error();
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new Error("integration_invalid_response");
  } finally {
    reader.releaseLock();
  }
}

/** Account adapters operate inside Cloudflare. The transport remains integration-independent. */
export function integrationDelivery(
  fetcher: typeof fetch = fetch,
): (value: string, request: CredentialRequest) => Promise<string> {
  const call = async (url: string, options: RequestInit): Promise<Response> => {
    try {
      return await fetcher(url, {
        ...options,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("integration_unavailable");
    }
  };
  return async (value, request) => {
    if (request.integrationId === "github") {
      if (
        typeof request.resource !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(
          request.resource,
        ) ||
        request.resource.split("/")[1]!.endsWith(".git")
      )
        throw new Error("invalid_repository");
      if (!["repo.read", "repo.write"].includes(request.capability))
        throw new Error("credential_scope_rejected");
      const response = await call("https://api.github.com/repos/" + request.resource, {
        headers: {
          Authorization: "Bearer " + value,
          "User-Agent": "OpenCodeTelegramCore/1",
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      await discard(response);
      if (!response.ok) {
        if (response.status === 401) throw new Error("credential_revoked");
        if (response.status === 403) throw new Error("repository_not_authorized");
        // GitHub intentionally hides private repositories from unauthorized tokens.
        if (response.status === 404) throw new Error("repository_unavailable");
        throw new Error("integration_unavailable");
      }
      const service = request.capability === "repo.write" ? "git-receive-pack" : "git-upload-pack";
      const transport = await call(
        `https://github.com/${request.resource}.git/info/refs?service=${service}`,
        {
          headers: {
            Authorization: "Basic " + btoa("x-access-token:" + value),
            "User-Agent": "OpenCodeTelegramCore/1",
          },
        },
      );
      await discard(transport);
      if (transport.status === 401) throw new Error("credential_revoked");
      if (transport.status === 403)
        throw new Error(
          request.capability === "repo.write"
            ? "insufficient_write_permission"
            : "insufficient_read_permission",
        );
      if (transport.status === 404) throw new Error("repository_unavailable");
      if (!transport.ok) throw new Error("integration_unavailable");
      if (
        !transport.headers.get("Content-Type")?.startsWith(`application/x-${service}-advertisement`)
      )
        throw new Error("integration_invalid_response");
      return value;
    }
    if (request.integrationId === "tailscale") {
      if (request.capability !== "device.enroll") throw new Error("credential_scope_rejected");
      const response = await call("https://api.tailscale.com/api/v2/tailnet/-/keys", {
        method: "POST",
        headers: { Authorization: "Bearer " + value, "Content-Type": "application/json" },
        body: JSON.stringify({
          expirySeconds: 300,
          description: `OpenCode Worker ${request.workerId} generation ${request.generation}`,
          capabilities: {
            devices: {
              create: {
                reusable: false,
                ephemeral: false,
                preauthorized: false,
                tags: ["tag:opencode-bot"],
              },
            },
          },
        }),
      });
      if (!response.ok) {
        await discard(response);
        if (response.status === 401) throw new Error("credential_revoked");
        if (response.status === 403) throw new Error("enrollment_not_authorized");
        throw new Error("integration_unavailable");
      }
      const payload = await json(response);
      if (
        typeof payload.key !== "string" ||
        !payload.key.startsWith("tskey-auth-") ||
        payload.key.length > 16384 ||
        /[\x00-\x20\x7f]/.test(payload.key)
      )
        throw new Error("integration_invalid_response");
      return payload.key;
    }
    return value;
  };
}
