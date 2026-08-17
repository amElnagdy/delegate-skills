import { join } from "node:path";

export const SKILLS = ["claude", "cline", "codex", "opencode", "agy", "grok", "kimi", "qoder", "vibe", "cursor", "pi", "aider", "copilot", "warp", "commandcode"];

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
  aider: [],
  copilot: [],
  warp: [],
  commandcode: [],
};

export const WIN = process.platform === "win32";

// commandcode's binary is `cmd`, which IS cmd.exe on Windows — the relay refuses to
// guess there and requires COMMANDCODE_BIN, so the shim is planted under its own name
// and pointed at by that variable instead of by PATH (see install-shim).
export const binaryName = (skill) =>
  skill === "qoder" ? "qodercli"
    : skill === "cursor" ? "cursor-agent"
      : skill === "warp" ? "oz"
        : skill === "commandcode" ? "cmd"
          : skill;

export const relayPath = (testDir, skill) =>
  join(testDir, "..", "skills", `${skill}-delegate`, "scripts", "relay.mjs");
