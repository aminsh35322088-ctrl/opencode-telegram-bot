#!/usr/bin/env node
// Raw Telegram update builders for the soak driver.
//
// They live in their own module so the harness contract they encode — the
// exact shape real Telegram sends — is testable without booting the Bot or the
// stub. Everything here must stay byte-compatible with what api.telegram.org
// actually delivers, because the Bot's own extraction (`getTopicFromMessage`,
// grammy's `Composer.command`) rejects anything else silently.
export function createUpdateBuilders({ userId }) {
  let messageId = 10_000;

  function messageUpdate(text, opts = {}) {
    messageId += 1;
    const message = {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: opts.chatId ?? userId, type: "private", first_name: "Soak" },
      from: { id: opts.fromId ?? userId, is_bot: false, first_name: "Soak" },
      text,
    };
    // Real Telegram attaches a `bot_command` entity to any text that starts with
    // "/". grammy's Composer.command() requires that entity (offset 0, type
    // `bot_command`) before it will dispatch, so without it EVERY Bot command is
    // silently ignored — the message still reaches message-router, which made the
    // gap look like a Bot bug rather than a harness gap. Verified: with no entity
    // the debug probe `cmdmw enter text="/start"` fired but the handler never did.
    if (text.startsWith("/")) {
      const space = text.indexOf(" ");
      message.entities = [{ offset: 0, length: space === -1 ? text.length : space, type: "bot_command" }];
    }
    if (opts.threadId) {
      message.message_thread_id = opts.threadId;
      // Real Telegram flags every message delivered into a forum Topic. Without
      // it the Bot's Topic extraction returns null and silently consumes the
      // control (Delete Chat pressed, no confirmation ever sent).
      message.is_topic_message = true;
    }
    return { message };
  }

  function stopUpdate(threadId, draftId) {
    return {
      stopped_message_generation: {
        chat: { id: userId, type: "private", first_name: "Soak" },
        ...(threadId ? { message_thread_id: threadId } : {}),
        draft_id: draftId,
      },
    };
  }

  function callbackUpdate(data, targetMessageId, threadId) {
    return {
      callback_query: {
        id: `cb-${Date.now()}`,
        from: { id: userId, is_bot: false, first_name: "Soak" },
        chat_instance: "soak",
        data,
        ...(targetMessageId !== null
          ? {
              message: {
                message_id: targetMessageId,
                date: Math.floor(Date.now() / 1000),
                chat: { id: userId, type: "private", first_name: "Soak" },
                ...(threadId ? { message_thread_id: threadId, is_topic_message: true } : {}),
              },
            }
          : {}),
      },
    };
  }

  return { messageUpdate, stopUpdate, callbackUpdate };
}
