import { InlineKeyboard } from "grammy";

const IMAGE_MODE_CALLBACK_PREFIX = "image_mode:";

export function activateImageMode() {
  return true;
}

export function createImageModeKeyboard() {
  return new InlineKeyboard();
}
