import { execFileSync } from "node:child_process";
import fs from "node:fs";

const eventPath = process.env.GITHUB_EVENT_PATH;

if (!eventPath || !fs.existsSync(eventPath)) {
  console.error("check:changelog: GITHUB_EVENT_PATH is required in CI.");
  process.exit(1);
}

const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
const pullRequest = event.pull_request;

if (!pullRequest?.base?.sha || !pullRequest?.head?.sha) {
  console.error("check:changelog: this check must run for a pull request event.");
  process.exit(1);
}

const changedFiles = execFileSync(
  "git",
  ["diff", "--name-only", `${pullRequest.base.sha}...${pullRequest.head.sha}`],
  { encoding: "utf8" },
)
  .split(/\r?\n/)
  .map((file) => file.trim())
  .filter(Boolean);

if (!changedFiles.includes("CHANGELOG.md")) {
  console.error("CHANGELOG.md must be updated on every pull request.");
  process.exit(1);
}

console.log("CHANGELOG.md update detected; changelog policy satisfied.");
