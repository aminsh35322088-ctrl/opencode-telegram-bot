// @ts-check
import { module } from "@prisma/composer";
import opencodeTelegramBotService from "./service.mjs";

export default module("opencode-telegram-bot", ({ provision }) => {
  provision(opencodeTelegramBotService, { id: "opencodetelegrambot" });
});
