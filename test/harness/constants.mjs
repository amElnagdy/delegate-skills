import { join } from "node:path";

export const SKILLS = ["claude", "cline", "codex", "opencode", "agy", "grok", "kimi", "qoder", "vibe", "cursor", "pi", "omp", "aider", "copilot", "warp", "zcode", "commandcode", "devin"];

export const EXTRA_ARGS = {
  claude: [],
  cline: [],
  codex: [],
  opencode: ["--model", "fake/model"],
  agy: [],
  grok: [],
  kimi: [],
  qoder: [],
  vibe: [],
  cursor: [],
  pi: [],
  omp: [],
  aider: [],
  copilot: [],
  warp: [],
  zcode: [],
  commandcode: [],
  devin: [],
};

export const WIN = process.platform === "win32";

export const binaryName = (skill) =>
  skill === "qoder" ? "qodercli"
    : skill === "cursor" ? "cursor-agent"
      : skill === "warp" ? "oz"
        : skill === "commandcode" ? (WIN ? "cmdc" : "cmd")
          : skill;

export const relayPath = (testDir, skill) =>
  join(testDir, "..", "skills", `${skill}-delegate`, "scripts", "relay.mjs");
