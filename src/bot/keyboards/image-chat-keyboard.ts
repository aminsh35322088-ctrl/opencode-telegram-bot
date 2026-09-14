import { Keyboard } from "grammy";
import type { ImageChatProfile } from "../../app/types/image-chat.js";
import { MAIN_BUTTONS } from "./main-reply-keyboard.js";

export const IMAGE_CHAT_BUTTONS = {
  newDesign: "🖼 New design",
  stop: "⏹ Stop",
  better: "✨ Better",
  modelPrefix: "🎨 Model · ",
} as const;

/** Reply keyboard for Image Chat Topics. Mirrors the coding Topic keyboard shape while staying isolated: its labels are routed by the image-chat middleware before any OpenCode router. */
function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function imageChatModelLabel(profile: ImageChatProfile): string {
  const model = profile.mode === "gemini"
    ? profile.modelID
    : `${profile.modelID} + ${profile.imageModelID ?? "image tool"}`;
  return truncate(`${IMAGE_CHAT_BUTTONS.modelPrefix}${model}`, 44);
}

export function createImageChatReplyKeyboard(profile: ImageChatProfile): Keyboard {
  const keyboard = new Keyboard();
  keyboard.text(IMAGE_CHAT_BUTTONS.newDesign).text(IMAGE_CHAT_BUTTONS.stop).row();
  keyboard.text(MAIN_BUTTONS.deleteChat).text(IMAGE_CHAT_BUTTONS.better).row();
  keyboard.text(imageChatModelLabel(profile)).text(MAIN_BUTTONS.topicSettings).row();
  return keyboard.resized();
}
