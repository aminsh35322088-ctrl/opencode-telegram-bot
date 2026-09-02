#!/bin/sh
set -eu

ACCOUNT_DIR="${RAILWAY_INTEGRATIONS_DIR:-/data/integrations/railway}"
INDEX_FILE="$ACCOUNT_DIR/accounts.json"

# The bot may change the active Railway account while the OpenCode process
# remains alive. Resolve the active token at MCP process start so the Railway
# CLI always gets the same credential the bot currently uses.
if [ -s "$INDEX_FILE" ] && command -v node >/dev/null 2>&1; then
  ACTIVE_ID="$(node -e '
const fs = require("node:fs");
const p = process.argv[1];
try {
  const index = JSON.parse(fs.readFileSync(p, "utf8"));
  const accounts = Array.isArray(index.accounts) ? index.accounts : [];
  const active = accounts.find((item) => item && item.id === index.activeId) ?? accounts[0];
  process.stdout.write(typeof active?.id === "string" ? active.id : "");
} catch {
  process.stdout.write("");
}
' "$INDEX_FILE")"

  if [ -n "$ACTIVE_ID" ]; then
    TOKEN_FILE="$ACCOUNT_DIR/$ACTIVE_ID.token"
    if [ -s "$TOKEN_FILE" ]; then
      TOKEN_TYPE="$(node -e '
const fs = require("node:fs");
const p = process.argv[1];
try {
  const index = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const account = (Array.isArray(index.accounts) ? index.accounts : []).find((item) => item && item.id === process.argv[1]);
  process.stdout.write(typeof account?.tokenType === "string" ? account.tokenType : "account");
} catch {
  process.stdout.write("account");
}
' "$ACTIVE_ID" "$INDEX_FILE")"
      TOKEN="$(cat "$TOKEN_FILE")"

      unset RAILWAY_TOKEN RAILWAY_API_TOKEN
      if [ "$TOKEN_TYPE" = "project" ]; then
        export RAILWAY_TOKEN="$TOKEN"
      else
        export RAILWAY_API_TOKEN="$TOKEN"
      fi
    fi
  fi
fi

exec railway mcp "$@"
