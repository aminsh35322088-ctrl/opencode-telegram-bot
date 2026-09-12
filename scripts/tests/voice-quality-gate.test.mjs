import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
const base = '../../dist/';
const modules = {
  'config.js': { config: { stt: { notePrompt: '' }, telegram: { proxyUrl: '' } } },
  'app/services/stt-service.js': { isSttConfigured() {}, transcribeAudio() {} },
  'bot/handlers/prompt.js': { processUserPrompt() {} },
  'bot/handlers/message-merger.js': { flushPendingPrompt() {} },
  'utils/logger.js': { logger: { info() {}, warn() {}, error() {} } },
  'app/services/file-download-service.js': { buildTelegramFileUrl() {} },
  'app/services/quoted-notification.js': { buildQuotedNotification: (title, text) => ({ text: `${title}\n${text}`, rawFallbackText: text }) },
  'bot/messages/telegram-text.js': { editBotText: async () => { if (failEdit) throw Error('edit failed'); } },
  'app/services/image-mode-service.js': { clearImageMode() {}, isImageModeActive: () => true },
  'bot/commands/media-command.js': { handleImageTextPrompt: async () => { imageCalls++; } },
};
let failEdit = false;
let imageCalls = 0;
for (const [path, namedExports] of Object.entries(modules)) mock.module(base + path, { namedExports });
const { handleVoiceMessage } = await import('../../dist/bot/handlers/voice-handler.js');
test('uncertain transcripts never reach coding or image execution, including edit failure', async () => {
  for (const editFailure of [false, true]) {
    failEdit = editFailure;
    let promptCalls = 0;
    const replies = [];
    const ctx = { message: { voice: { file_id: 'voice' } }, chat: { id: 1 }, api: {}, reply: async text => { replies.push(text); return { message_id: 2 }; } };
    await handleVoiceMessage(ctx, {
      isSttConfigured: () => true,
      downloadTelegramFile: async () => ({ buffer: Buffer.from('audio'), filename: 'voice.ogg' }),
      transcribeAudio: async () => ({ text: 'uncertain command', uncertain: true }),
      processPrompt: async () => { promptCalls++; },
    });
    assert.equal(promptCalls, 0);
    assert.equal(imageCalls, 0);
    if (editFailure) assert.match(replies.at(-1), /uncertain command/);
  }
});
