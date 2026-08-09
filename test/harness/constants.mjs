import { join } from "node:path";

export const SKILLS = ["claude", "codex", "opencode", "agy", "grok", "kimi", "qoder", "vibe", "cursor", "pi"];

export const EXTRA_ARGS = {
  claude: [],
  codex: [],
  opencode: ["--model", "fake/model"],
  agy: [],
  grok: [],
  kimi: [],
  qoder: [],
  vibe: [],
  cursor: [],
  pi: [],
};

export const WIN = process.platform === "win32";

export const binaryName = (skill) =>
  skill === "qoder" ? "qodercli" : skill === "cursor" ? "cursor-agent" : skill;

export const relayPath = (testDir, skill) =>
  join(testDir, "..", "skills", `${skill}-delegate`, "scripts", "relay.mjs");
