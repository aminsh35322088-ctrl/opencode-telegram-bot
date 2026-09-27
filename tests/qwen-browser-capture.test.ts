import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { captureScript } from "../src/app/services/free-source-browser-bootstrap.js";

test("stores Baxia headers from the verified completion rather than an earlier page request", async () => {
  const listeners = new Map<string, (request: unknown) => void>();
  const request = (url: string, suffix: string) => ({
    url: () => url,
    headers: () => ({ "bx-ua": `ua-${suffix}`, "bx-umidtoken": `token-${suffix}`, "bx-v": `v-${suffix}` }),
  });
  const page = {
    on: (event: string, listener: (request: unknown) => void) => listeners.set(event, listener),
    off: (event: string) => listeners.delete(event),
    goto: async () => listeners.get("request")?.(request("https://chat.qwen.ai/api/v2/config", "initial")),
    evaluate: async () => {
      listeners.get("request")?.(request("https://chat.qwen.ai/api/v2/chat/completions?chat_id=x", "completion"));
      return { step: "completions", status: 200, ct: "text/event-stream", body: "data: hi" };
    },
  };
  const script = vm.runInNewContext(`(${captureScript()})`) as (page: typeof page) => Promise<string>;
  const result = JSON.parse((await script(page)).replace(/^__OTB_QWEN_BX__/, ""));
  assert.deepEqual(JSON.parse(JSON.stringify(result.captured)), {
    bxUA: "ua-completion", bxUmidToken: "token-completion", bxV: "v-completion",
  });
});
