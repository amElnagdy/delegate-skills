/**
 * Canonical implementer registry for delegate-setup.
 *
 * One table: skill key → binary, launch hints, supported lane dials, probes.
 * Consumed by discover.mjs and config.mjs. Relays will share this in Phase 2.
 *
 * `usageProbe.path` walks down from the CLI's state directory to the folders that
 * hold session entries ("*" matches any directory at that level); `entry` + `match`
 * say which names count as one session. Session files hold the user's conversations,
 * so these are listed and stat'd only — never opened.
 *
 * Node built-ins only. No network, credentials, or telemetry.
 */

/** @typedef {"model"|"effort"|"variant"|"timeout"|"readOnly"|"sandbox"|"permissionMode"|"force"|"provider"} Dial */

/**
 * @type {readonly {
 *   key: string,
 *   skill: string,
 *   binary: string,
 *   versionArgs: string[],
 *   versionFallbackArgs?: string[],
 *   versionFormat?: "colon-prefix",
 *   authProbe: null | {
 *     args: string[],
 *     jsonField?: string,
 *     successPattern?: RegExp,
 *     failPattern?: RegExp,
 *     missMeansFalse?: boolean,
 *   },
 *   modelProbe: null
 *     | { args: string[], format: "lines"|"cursor"|"grok"|"table" }
 *     | { envDir: string, homeSubdir: string, file: string, format: "codex-cache" }
 *     | { static: readonly string[] },
 *   usageProbe: null | {
 *     envDir?: string,
 *     homeSubdir: string,
 *     path: readonly string[],
 *     entry: "file"|"dir"|"any",
 *     match: RegExp,
 *   },
 *   supports: Dial[],
 *   winShell: boolean,
 * }[]}
 */
export const IMPLEMENTERS = Object.freeze([
  {
    key: "claude",
    skill: "claude-delegate",
    binary: "claude",
    versionArgs: ["--version"],
    authProbe: { args: ["auth", "status"], jsonField: "loggedIn" },
    // No listing command; `--model` takes one of these aliases or a full model name.
    modelProbe: { static: ["fable", "opus", "sonnet", "haiku"] },
    // <config>/projects/<project-slug>/<session-uuid>.jsonl — one file per session.
    usageProbe: {
      envDir: "CLAUDE_CONFIG_DIR",
      homeSubdir: ".claude",
      path: ["projects", "*"],
      entry: "file",
      match: /\.jsonl$/,
    },
    supports: ["model", "effort", "timeout", "readOnly"],
    winShell: true,
  },
  {
    key: "cline",
    skill: "cline-delegate",
    binary: "cline",
    versionArgs: ["--version"],
    // No status command exposes login state; usage stays unknown rather than guessed —
    // the CLI's conversations live under a profile that has no documented stable path.
    authProbe: null,
    modelProbe: null,
    usageProbe: null,
    // Plan mode is a dispatch flag (--plan), not a lane dial; readOnly is unsupported.
    supports: ["provider", "model", "timeout"],
    winShell: true,
  },
  {
    key: "codex",
    skill: "codex-delegate",
    binary: "codex",
    versionArgs: ["--version"],
    // codex writes login status to stderr, not stdout.
    authProbe: {
      args: ["login", "status"],
      successPattern: /logged in/i,
      failPattern: /not logged in/i,
    },
    // Never spawn `codex models`: the positional word is read as a prompt and hits the API.
    // The locally cached catalog is the only offline listing.
    modelProbe: {
      envDir: "CODEX_HOME",
      homeSubdir: ".codex",
      file: "models_cache.json",
      format: "codex-cache",
    },
    // sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl. archived_sessions is a second
    // store of the same shape; counting only live rollouts keeps one meaning per number.
    usageProbe: {
      envDir: "CODEX_HOME",
      homeSubdir: ".codex",
      path: ["sessions", "*", "*", "*"],
      entry: "file",
      match: /^rollout-.*\.jsonl$/,
    },
    supports: ["model", "effort", "sandbox", "timeout", "readOnly"],
    winShell: true,
  },
  {
    key: "opencode",
    skill: "opencode-delegate",
    binary: "opencode",
    versionArgs: ["--version"],
    // Exits 0 with an empty list too; a "●" row is the only auth signal, so a clean run
    // without one is the logged-out state, not an ambiguous miss.
    authProbe: { args: ["auth", "list"], successPattern: /^●\s/m, missMeansFalse: true },
    modelProbe: { args: ["models"], format: "lines" },
    // No usage probe: the session files under ~/.local/share/opencode/storage stopped
    // being written when OpenCode moved to opencode.db, and a session count from that
    // database would mean opening conversation content.
    usageProbe: null,
    // OpenCode reasoning intensity is --variant, not --effort.
    supports: ["model", "variant", "timeout", "readOnly"],
    winShell: true,
  },
  {
    key: "agy",
    skill: "agy-delegate",
    binary: "agy",
    versionArgs: ["changelog"],
    versionFormat: "colon-prefix",
    authProbe: null,
    modelProbe: { args: ["models"], format: "lines" },
    // Antigravity keeps CLI state under ~/.gemini, one .db per conversation.
    usageProbe: {
      homeSubdir: ".gemini/antigravity-cli",
      path: ["conversations"],
      entry: "file",
      match: /\.db$/,
    },
    supports: ["model", "effort", "timeout", "readOnly"],
    winShell: false,
  },
  {
    key: "grok",
    skill: "grok-delegate",
    binary: "grok",
    versionArgs: ["version"],
    versionFallbackArgs: ["--version"],
    authProbe: { args: ["models"], failPattern: /not authenticated/i },
    modelProbe: { args: ["models"], format: "grok" },
    // sessions/<url-encoded-cwd>/<session-uuid>/ — one directory per session; the
    // prompt_history.jsonl sitting beside them is per-workspace, not per-session.
    usageProbe: {
      homeSubdir: ".grok",
      path: ["sessions", "*"],
      entry: "dir",
      match: /^[0-9a-f]{8}-[0-9a-f]{4}-/i,
    },
    supports: ["model", "effort", "sandbox", "timeout", "readOnly"],
    winShell: true,
  },
  {
    key: "kimi",
    skill: "kimi-delegate",
    binary: "kimi",
    versionArgs: ["--version"],
    authProbe: { args: ["provider", "list"], successPattern: /source=(oauth|api)/ },
    // No credential-free listing exists: the provider-list JSON and the config file behind it
    // both inline provider api keys, and this script may not buffer credentials.
    modelProbe: null,
    // sessions/<wd_workspace>/session_<uuid>/ — one directory per session.
    usageProbe: {
      homeSubdir: ".kimi-code",
      path: ["sessions", "*"],
      entry: "dir",
      match: /^session_/,
    },
    supports: ["model", "timeout"],
    winShell: false,
  },
  {
    key: "qoder",
    skill: "qoder-delegate",
    binary: "qodercli",
    versionArgs: ["--version"],
    authProbe: null,
    modelProbe: null,
    // No documented local session store; usage stays unknown rather than guessed.
    usageProbe: null,
    supports: ["model", "permissionMode", "timeout", "readOnly"],
    winShell: false,
  },
  {
    key: "vibe",
    skill: "vibe-delegate",
    binary: "vibe",
    versionArgs: ["--version"],
    authProbe: null,
    modelProbe: null,
    usageProbe: null,
    supports: ["timeout", "readOnly"],
    winShell: false,
  },
  {
    key: "cursor",
    skill: "cursor-delegate",
    binary: "cursor-agent",
    versionArgs: ["--version"],
    authProbe: {
      args: ["status"],
      successPattern: /logged in as/i,
      failPattern: /not logged in/i,
    },
    modelProbe: { args: ["models"], format: "cursor" },
    // projects/<project-slug>/agent-transcripts/<chat-uuid>/ — what the CLI writes per
    // chat; some layouts write flat <chat-uuid>.txt files instead, so accept either.
    // ~/.cursor/chats holds only a handful of older IDE-side entries.
    usageProbe: {
      homeSubdir: ".cursor",
      path: ["projects", "*", "agent-transcripts"],
      entry: "any",
      match: /^[0-9a-f]{8}-[0-9a-f]{4}-/i,
    },
    // Cursor sandbox is explicit per dispatch only; it is intentionally not a fleet dial.
    supports: ["model", "force", "timeout", "readOnly"],
    winShell: true,
  },
  {
    key: "pi",
    skill: "pi-delegate",
    binary: "pi",
    versionArgs: ["--version"],
    authProbe: null,
    // Must stay a flag: `pi models` is read as a prompt and hits the API.
    modelProbe: { args: ["--list-models"], format: "table" },
    // ~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl.
    usageProbe: {
      homeSubdir: ".pi/agent",
      path: ["sessions", "*"],
      entry: "file",
      match: /\.jsonl$/,
    },
    supports: ["provider", "model", "timeout", "readOnly"],
    winShell: true,
  },
  {
    key: "aider",
    skill: "aider-delegate",
    binary: "aider",
    versionArgs: ["--version"],
    // Aider has no auth subcommand; it reads provider keys from the environment
    // and its own config, and reports a failure only once a run reaches the model.
    authProbe: null,
    // `aider --list-models` needs a partial-name argument, so there is no listing
    // that covers the catalog; leaving this null beats probing with a guessed query.
    modelProbe: null,
    // No global session store: Aider keeps its chat history in the repo itself
    // (.aider.chat.history.md), so there is nothing per-user to count.
    usageProbe: null,
    supports: ["model", "timeout", "readOnly"],
    winShell: false,
  },
  {
    key: "copilot",
    skill: "copilot-delegate",
    binary: "copilot",
    versionArgs: ["version"],
    // No status command exposes login state; copilot login is interactive only
    // and there is no `copilot auth status` equivalent.
    authProbe: null,
    // No credential-free model listing command exists.
    modelProbe: null,
    // No documented local session store path is verified.
    usageProbe: null,
    supports: ["model", "effort", "timeout", "readOnly"],
    winShell: true,
  },
  {
    key: "warp",
    skill: "warp-delegate",
    binary: "oz",
    versionArgs: ["--version"],
    // `--output-format text` prints one `type:id` line; the default `pretty` format
    // spells the type out ("User ID: …") and so reads differently per principal. A
    // headless host authenticated with WARP_API_KEY is a service account, not a
    // user, so the probe must accept both or it reports CI as logged out.
    authProbe: {
      args: ["whoami", "--output-format", "text"],
      successPattern: /^(?:user|service_account):\S/m,
    },
    // `oz model list` emits a JSON array of {id} objects, which none of the shared
    // list formats parse; ids are read from the CLI directly instead of probed.
    modelProbe: null,
    // Conversations live server-side, so there is no local session directory to count.
    usageProbe: null,
    // `oz agent run` exposes no sandbox, permission-mode, or read-only flag, so
    // those dials are deliberately absent — the relay refuses a lane that sets one.
    supports: ["model", "timeout"],
    winShell: false,
  },
]);

/** Prototype-free map so names like "toString" cannot pass as implementers. */
export const IMPLEMENTER_BY_KEY = Object.freeze(
  IMPLEMENTERS.reduce((map, impl) => {
    map[impl.key] = impl;
    return map;
  }, Object.create(null)),
);

export const CLAUDE_EFFORT = Object.freeze(["low", "medium", "high", "xhigh", "max", "ultracode"]);
export const AGY_EFFORT = Object.freeze(["low", "medium", "high"]);
export const COPILOT_EFFORT = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
export const CODEX_SANDBOX = Object.freeze(["read-only", "workspace-write", "danger-full-access"]);
export const GROK_SANDBOX = Object.freeze(["workspace", "read-only", "off"]);
export const QODER_PERMISSION = Object.freeze([
  "default",
  "accept_edits",
  "auto",
  "bypass_permissions",
  "dont_ask",
  "plan",
]);
/** Positive h/m/s duration, same shape relays accept. */
export const TIMEOUT_RE = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

/**
 * Model/provider token shapes mirrored from each relay's parseArgs.
 * Relays that do not constrain the string still get a non-empty check in config.mjs.
 */
export const MODEL_TOKEN = Object.freeze({
  /** Keep in lockstep with claude-delegate SAFE_MODEL. */
  claude: /^[A-Za-z0-9][A-Za-z0-9._:@\/\[\]-]*$/,
  /** Keep in lockstep with cursor-delegate SAFE_MODEL. */
  cursor: /^[A-Za-z0-9][A-Za-z0-9._:@\/\[\]\,=-]*$/,
  /** Keep in lockstep with grok/pi/codex shell-safe tokens (also used for opencode). */
  shellSafe: /^[A-Za-z0-9][A-Za-z0-9._:\/-]*$/,
});

export const CONFIG_VERSION = "delegate-fleet.v1";
export const LANE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const ALL_DIALS = Object.freeze([
  "model",
  "effort",
  "variant",
  "timeout",
  "readOnly",
  "sandbox",
  "permissionMode",
  "force",
  "provider",
]);
