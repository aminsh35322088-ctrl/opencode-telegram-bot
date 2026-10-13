import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { buildTelegramConfig, resetTelegramConfigForTests } from "../src/config.js";

const TOKEN_KEY = "TELEGRAM_BOT_TOKEN";
const USER_KEY = "TELEGRAM_USER_ID";
const ROOT_KEY = "TELEGRAM_API_ROOT";

const saved = {
  token: process.env[TOKEN_KEY],
  user: process.env[USER_KEY],
  root: process.env[ROOT_KEY],
};

beforeEach(() => {
  process.env[TOKEN_KEY] = "123:soak";
  process.env[USER_KEY] = "123456789";
  delete process.env[ROOT_KEY];
  resetTelegramConfigForTests();
});

afterEach(() => {
  if (saved.token === undefined) delete process.env[TOKEN_KEY];
  else process.env[TOKEN_KEY] = saved.token;
  if (saved.user === undefined) delete process.env[USER_KEY];
  else process.env[USER_KEY] = saved.user;
  if (saved.root === undefined) delete process.env[ROOT_KEY];
  else process.env[ROOT_KEY] = saved.root;
  resetTelegramConfigForTests();
});

test("Telegram API root stays empty by default so grammY dials api.telegram.org", () => {
  assert.equal(buildTelegramConfig().apiRoot, "");
});

test("TELEGRAM_API_ROOT redirects the Bot API client to a local stub", () => {
  process.env[ROOT_KEY] = "http://127.0.0.1:8081";
  resetTelegramConfigForTests();
  assert.equal(buildTelegramConfig().apiRoot, "http://127.0.0.1:8081");
});

test("TELEGRAM_API_ROOT is trimmed and never carries a trailing slash", () => {
  process.env[ROOT_KEY] = "  http://127.0.0.1:8081/  ";
  resetTelegramConfigForTests();
  assert.equal(buildTelegramConfig().apiRoot, "http://127.0.0.1:8081");
});

test("a blank TELEGRAM_API_ROOT is treated as unset", () => {
  process.env[ROOT_KEY] = "   ";
  resetTelegramConfigForTests();
  assert.equal(buildTelegramConfig().apiRoot, "");
});
