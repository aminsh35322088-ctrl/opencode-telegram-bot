// Run after npm run build: node --experimental-test-module-mocks --test scripts/tests/stt-regression.test.mjs
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { assessTranscription } from '../../dist/app/services/stt-quality.js';

const segment = (values = {}) => ({ avg_logprob: -0.2, no_speech_prob: 0.01, compression_ratio: 1.5, ...values });
const stt = { apiUrl: '', apiKey: '', model: 'whisper-large-v3', language: '', requestFormat: 'multipart' };
let custom = { apiUrl: 'https://api.groq.com/openai/v1', apiKey: 'test-key', model: 'whisper-large-v3' };
mock.module('../../dist/config.js', { namedExports: { config: { stt } } });
mock.module('../../dist/app/services/custom-provider-service.js', { namedExports: { getGroqSttConfig: async () => custom } });
mock.module('../../dist/utils/logger.js', { namedExports: { logger: { debug() {}, info() {}, warn() {} } } });
const { transcribeAudio } = await import('../../dist/app/services/stt-service.js');

const text = 'این فایل رو با TypeScript اصلاح کن.';
test('quality preserves mixed Persian/English speech and does not delete uncertain fragments', () => {
  assert.deepEqual(assessTranscription(text, [segment()]), { text });
  assert.deepEqual(assessTranscription(text, [segment({ no_speech_prob: 0.9 })]), { text });
  assert.deepEqual(assessTranscription(text, [segment(), segment({ avg_logprob: -1.4, no_speech_prob: 0.9 })]), { text, uncertain: true });
  assert.deepEqual(assessTranscription(text, [segment({ avg_logprob: -1.4, no_speech_prob: 0.9 })]), { text: '' });
  assert.equal(assessTranscription(text, [segment({ compression_ratio: 3 })]).uncertain, true);
  assert.equal(assessTranscription(text, [{ avg_logprob: null }]).uncertain, true);
  assert.equal(assessTranscription(text, undefined).uncertain, true);
});

test('Groq uploads original audio without vocabulary injection and uses one request for clean speech', async () => {
  const original = new Uint8Array([79, 103, 103, 83, 1, 2]);
  const calls = [];
  const stub = mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(options);
    assert.equal(url, 'https://api.groq.com/openai/v1/audio/transcriptions');
    assert.equal(options.body.get('prompt'), null);
    assert.equal(options.body.get('response_format'), 'verbose_json');
    assert.equal(options.body.get('language'), 'fa');
    assert.deepEqual(new Uint8Array(await options.body.get('file').arrayBuffer()), original);
    return Response.json({ text, segments: [segment()] });
  });
  try {
    assert.deepEqual(await transcribeAudio(Buffer.from(original), 'voice.ogg'), { text });
    assert.equal(calls.length, 1);
  } finally { stub.mock.restore(); }
});

test('uncertain results get at most one alternative attempt, and failed retries retain uncertainty', async () => {
  for (const outcome of ['good', 'bad', 'http', 'empty']) {
    let calls = 0;
    const stub = mock.method(globalThis, 'fetch', async (_url, options) => {
      calls++;
      if (calls === 1) return Response.json({ text, segments: [segment({ avg_logprob: -1.2 })] });
      assert.equal(options.body.get('language'), null);
      if (outcome === 'http') return new Response('secret upstream detail', { status: 429 });
      return Response.json({ text: outcome === 'empty' ? '' : text, segments: [segment({ avg_logprob: outcome === 'bad' ? -1.2 : -0.2 })] });
    });
    try {
      const result = await transcribeAudio(Buffer.from('audio'), 'voice.ogg');
      assert.equal(Boolean(result.uncertain), outcome !== 'good');
      assert.equal(calls, 2);
    } finally { stub.mock.restore(); }
  }
});

test('generic JSON provider keeps its API contract and does not retry', async () => {
  custom = undefined;
  Object.assign(stt, { apiUrl: 'https://example.test/v1', apiKey: 'test', requestFormat: 'json', language: 'en' });
  const stub = mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { model: 'whisper-large-v3', input_audio: { data: Buffer.from('audio').toString('base64'), format: 'ogg' }, language: 'en' });
    return Response.json({ text: 'hello' });
  });
  try { assert.deepEqual(await transcribeAudio(Buffer.from('audio'), 'voice.ogg'), { text: 'hello' }); }
  finally { stub.mock.restore(); }
});
