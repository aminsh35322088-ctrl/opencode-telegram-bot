#!/usr/bin/env node
import { stdin, argv, exit } from "node:process";
import {
  listSshCredentialSummaries,
  removeSshCredential,
  saveSshPasswordCredential,
  saveSshPrivateKeyCredential,
} from "../dist/app/services/ssh-credential-store.js";

async function readStdin() {
  let value = "";
  for await (const chunk of stdin) value += chunk.toString();
  return value.replace(/\r?\n$/u, "");
}

function usage() {
  console.error([
    "Usage:",
    "  opencode-ssh-credential list",
    "  opencode-ssh-credential set-password <id> [label]    # secret from stdin",
    "  opencode-ssh-credential set-key <id> [label]         # private key from stdin",
    "  opencode-ssh-credential remove <id>",
    "",
    "Examples:",
    "  read -rsp 'SSH password: ' P; printf '%s' \"$P\" | opencode-ssh-credential set-password my-vps 'My VPS'; unset P",
    "  cat ~/.ssh/id_ed25519 | opencode-ssh-credential set-key my-vps-key 'My VPS key'",
  ].join("\n"));
}

const [action, id, ...labelParts] = argv.slice(2);
try {
  if (action === "list") {
    console.log(JSON.stringify(await listSshCredentialSummaries(), null, 2));
    exit(0);
  }
  if (action === "remove") {
    if (!id) throw new Error("remove requires id");
    console.log(JSON.stringify({ removed: await removeSshCredential(id), id }, null, 2));
    exit(0);
  }
  if (action === "set-password" || action === "set-key") {
    if (!id) throw new Error(`${action} requires id`);
    if (stdin.isTTY) throw new Error("Secret input must come from stdin; refusing to read an echoed TTY value.");
    const secret = await readStdin();
    const label = labelParts.join(" ").trim() || id;
    const result = action === "set-password"
      ? await saveSshPasswordCredential(id, label, secret)
      : await saveSshPrivateKeyCredential(id, label, secret);
    console.log(JSON.stringify({ ok: true, credential: result }, null, 2));
    exit(0);
  }
  usage();
  exit(2);
} catch (error) {
  console.error((error instanceof Error ? error.message : String(error)));
  exit(1);
}
