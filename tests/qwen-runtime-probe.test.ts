import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probeQwenModel } from '../src/app/services/qwen-runtime-probe.js';

const chunk = (content: string, finish: string | null = null) => `data: ${JSON.stringify({choices:[{delta:{content},finish_reason:finish}]})}\n\n`;

test('probes the selected model through the public streaming router with its client key', async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const result = await probeQwenModel('http://127.0.0.1:3099', 'client-key', 'qwen3.8-max', async (url, init) => {
    request = {url: String(url), init};
    return new Response(chunk('OK') + chunk('', 'stop') + 'data: [DONE]\n\n', {headers: {'Content-Type':'text/event-stream'}});
  });
  assert.equal(result.usable, true);
  assert.equal(result.outputChars, 2);
  assert.equal(request?.url, 'http://127.0.0.1:3099/v1/chat/completions');
  assert.equal(new Headers(request?.init?.headers).get('Authorization'), 'Bearer client-key');
  const body = JSON.parse(String(request?.init?.body));
  assert.equal(body.model, 'qwen/qwen3.8-max');
  assert.equal(body.stream, true);
});

test('rejects HTTP 200 streams containing a provider error after an initial empty chunk', async () => {
  const result = await probeQwenModel('http://localhost', 'key', 'qwen3.8-max', async () => new Response(
    chunk('') + 'data: {"error":{"message":"RGV587_ERROR WAF captcha","code":503}}\n\ndata: [DONE]\n\n',
    {headers:{'Content-Type':'text/event-stream'}},
  ));
  assert.equal(result.usable, false);
  assert.equal(result.reason, 'Qwen rejected access (RGV587/WAF).');
});

test('rejects empty streams and non-SSE success pages', async () => {
  for (const response of [
    new Response(chunk('') + 'data: [DONE]\n\n', {headers:{'Content-Type':'text/event-stream'}}),
    new Response('<html>dashboard</html>', {headers:{'Content-Type':'text/html'}}),
  ]) {
    const result = await probeQwenModel('http://localhost', 'key', 'qwen3.8-max', async () => response);
    assert.equal(result.usable, false);
  }
});
