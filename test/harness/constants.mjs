import { join } from "node:path";

export const SKILLS = ["claude", "cline", "commandcode", "codex", "opencode", "agy", "grok", "kimi", "qoder", "vibe", "cursor", "pi", "aider"];

export const EXTRA_ARGS = {
  claude: [],
  cline: [],
  commandcode: [],
  codex: [],
  opencode: ["--model", "fake/model"],
  agy: [],
  grok: [],
  kimi: [],
  qoder: [],
  vibe: [],
  cursor: [],
  pi: [],
  aider: [],
};

export const WIN = process.platform === "win32";

export const binaryName = (skill) =>
  skill === "qoder" ? "qodercli" : skill === "cursor" ? "cursor-agent" : skill === "commandcode" ? "command-code" : skill;

export const relayPath = (testDir, skill) =>
  join(testDir, "..", "skills", `${skill}-delegate`, "scripts", "relay.mjs");
