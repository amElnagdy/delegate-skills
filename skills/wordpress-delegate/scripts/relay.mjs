#!/usr/bin/env node
/**
 * delegate-skills · wordpress-delegate · relay.mjs
 *
 * Route a WordPress coding task to the sibling delegate best suited to it, then
 * dispatch through that sibling's own relay. This relay launches no implementer
 * CLI of its own: it classifies the brief, prepends the WordPress engineering
 * preamble, and hands the composed brief to `skills/<implementer>-delegate/
 * scripts/relay.mjs`, which owns every CLI-specific mechanic. One layer, one
 * job — routing — with dispatch, polling, and the result contract reused from
 * the sibling verbatim.
 *
 * Trust posture: relay.mjs itself makes no network calls, reads or writes no
 * credentials, and sends no telemetry; it has no dependencies (Node built-ins
 * only). It shells out only to `node` (for the sibling relay) and `git`. The
 * implementer CLI the sibling launches does authenticate — exactly as you do at
 * the terminal. Read this file, and the sibling's, before you run them.
 *
 * It deliberately does NOT commit, and neither does any sibling. Committing is
 * always the orchestrator's job — after it reviews the diff and re-runs the
 * project gates.
 *
 * Usage:
 *   node relay.mjs --brief <file> [options] [-- <implementer relay args>]
 *   cat brief.txt | node relay.mjs [options]
 *
 * Routing options:
 *   --implementer <name>    Force the implementer, bypassing the router. One of:
 *                           agy, claude, codex, cursor, grok, kimi, opencode, pi,
 *                           qoder, vibe.
 *   --lane <name>           Force the lane; the lane table still resolves the
 *                           implementer. See --list-routes.
 *   --strict-routing        Refuse to dispatch when the router's confidence is
 *                           "low" or "none", or when two lanes tie. Exits 3 with
 *                           the question to put to the user.
 *   --dry-run               Print the routing decision as JSON and exit 0 without
 *                           dispatching. Writes no result file.
 *   --list-routes           Print the lane table and the implementer table, then exit 0.
 *   --print-preamble        Print the WordPress engineering preamble and exit 0.
 *   --no-preamble           Send the brief verbatim, with no preamble prepended.
 *                           (Implied on --session / --resume-last: the preamble is
 *                           already in the resumed session's context.)
 *   --implementer-relay <p> Absolute path to a sibling relay.mjs. Use when only this
 *                           skill is installed and the sibling directories are absent.
 *
 * Forwarded options (passed to the sibling relay):
 *   --brief <file>          Path to the brief. If omitted, the brief is read from stdin.
 *   --cd <dir>              Working root (default: current directory).
 *   --model <name>          Implementer model. Required when routing to opencode.
 *   --read-only             Review/diagnosis with no edits. Translated to the chosen
 *                           implementer's own flag (`--read-only`, `--plan-only`, or
 *                           `--permission-mode plan`). Rejected for implementers that
 *                           have no read-only mode — see --list-routes.
 *   --session <id>          Continue a specific session; translated to the chosen
 *                           implementer's own resume flag. Send only the delta brief.
 *   --resume-last           Continue the most recent session of the chosen implementer.
 *   --timeout <dur>         Watchdog, honoured by the sibling. Durations use h/m/s
 *                           strings like 30m or 2h. This relay arms a backstop 60s
 *                           later in case the sibling itself wedges.
 *   --out-dir <dir>         Where to write run artifacts (default: a fresh dir under
 *                           the system temp dir). The sibling's own artifacts land in
 *                           <out-dir>/implementer/.
 *   --                      Everything after this is forwarded to the sibling relay
 *                           verbatim, for implementer-specific flags this relay does
 *                           not model (e.g. --sandbox, --effort, --permission-mode).
 *   -h, --help              Show this help.
 *
 * Result: written to <out-dir>/result.json and summarized on stdout. It speaks
 *   delegate-relay.result.v1 — status, exitCode, signal, finalMessage, touchedFiles,
 *   session — lifted from the sibling's own result, plus a `routing` block recording
 *   the lane, implementer, confidence, matched signals, and detected domains, and
 *   `implementerResult` carrying the sibling's result verbatim.
 *
 * Exit codes: a pre-run usage error (bad/missing args, empty brief, unknown
 * implementer, unroutable brief under --strict-routing) exits 2 or 3 before any run
 * and writes no result file; a missing sibling relay exits 127 with a result file;
 * otherwise the exit code mirrors the sibling's, which mirrors the implementer's.
 * Once the brief validates and a sibling is resolved, result.json is written on every
 * outcome — whatever the sibling reports, plus timeout (this relay's backstop fired)
 * and aborted (this relay was killed and forwarded the kill).
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { constants, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const MAX_TIMER_MS = 2_147_483_647;
// The sibling owns the watchdog for --timeout. This relay arms a backstop one grace
// window later, for the one case the sibling cannot cover: the sibling itself wedging
// before it arms its own timer. Long enough that the two never race on a healthy run.
const BACKSTOP_GRACE_MS = 60_000;
// A sibling handling SIGTERM writes its result, then refreshes touchedFiles ~2s later
// before exiting. Wait past that so the forwarded kill still yields a complete snapshot.
const SIBLING_SHUTDOWN_GRACE_MS = 8_000;

const here = dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ *
 * Implementer table — one row per sibling delegate.
 *
 * Each row states, in that CLI's own terms, only what this relay needs to
 * translate a portable flag into the sibling's flag. Everything else about the
 * implementer stays in the sibling's own SKILL.md and relay.mjs.
 *
 *   dir          the sibling skill directory under skills/
 *   readOnly     argv for a read-only run, or null when the CLI has no such mode
 *   sessionFlag  the sibling's flag for resuming one specific session
 *   requiresModel  the sibling rejects a run with no --model
 *   note         one line, surfaced by --list-routes
 * ------------------------------------------------------------------ */
const IMPLEMENTERS = {
  agy: {
    dir: "agy-delegate",
    readOnly: null,
    sessionFlag: "--conversation",
    requiresModel: false,
    note: "Google Antigravity (agy) — no CLI-enforced read-only mode.",
  },
  claude: {
    dir: "claude-delegate",
    readOnly: ["--read-only"],
    sessionFlag: "--session",
    requiresModel: false,
    note: "Claude Code (claude) — read-only is plan mode, with a porcelain tripwire.",
  },
  codex: {
    dir: "codex-delegate",
    readOnly: ["--read-only"],
    sessionFlag: "--session",
    requiresModel: false,
    note: "OpenAI Codex (codex) — read-only is sandbox-enforced.",
  },
  cursor: {
    dir: "cursor-delegate",
    readOnly: ["--read-only"],
    sessionFlag: "--session",
    requiresModel: false,
    note: "Cursor Agent (cursor-agent) — read-only is plan mode.",
  },
  grok: {
    dir: "grok-delegate",
    readOnly: ["--read-only"],
    sessionFlag: "--session",
    requiresModel: false,
    note: "Grok Build (grok) — read-only is best-effort; check readOnlyViolation.",
  },
  kimi: {
    dir: "kimi-delegate",
    readOnly: null,
    sessionFlag: "--session",
    requiresModel: false,
    note: "Kimi Code (kimi) — auto permission mode always; no read-only mode.",
  },
  opencode: {
    dir: "opencode-delegate",
    readOnly: ["--read-only"],
    sessionFlag: "--session",
    requiresModel: true,
    note: "OpenCode (opencode) — agent build/plan; --model is required.",
  },
  pi: {
    dir: "pi-delegate",
    readOnly: ["--read-only"],
    sessionFlag: "--session",
    requiresModel: false,
    note: "Pi (pi) — read-only restricts tools to read,grep,find,ls.",
  },
  qoder: {
    dir: "qoder-delegate",
    readOnly: ["--permission-mode", "plan"],
    sessionFlag: "--resume",
    requiresModel: false,
    note: "Qoder CLI (qodercli) — read-only is permission mode plan.",
  },
  vibe: {
    dir: "vibe-delegate",
    readOnly: ["--plan-only"],
    sessionFlag: "--session",
    requiresModel: false,
    note: "Mistral Vibe (vibe) — read-only is the plan agent.",
  },
};

/* ------------------------------------------------------------------ *
 * Lane table — the routing rules. THIS is the extension point.
 *
 * To add a lane: append a row. To re-target one: change its `implementer`.
 * Nothing else in this file knows the lane names.
 *
 *   name         lane id, also accepted by --lane
 *   implementer  key into IMPLEMENTERS
 *   signals      regexes; each DISTINCT match adds 1 to the lane's score
 *   readOnly     true when the lane is diagnosis, not edits (implies --read-only)
 *   why          one line explaining the routing choice, recorded in result.json
 *
 * Scoring: the highest-scoring lane wins. Two or more lanes tied above zero are
 * "contested" and the first tied row wins, because lane order encodes precedence —
 * a security audit that also mentions performance is still a security audit.
 * A zero score falls through to DEFAULT_LANE.
 * ------------------------------------------------------------------ */
const LANES = [
  {
    name: "security-audit",
    implementer: "grok",
    readOnly: true,
    why: "Security review wants an adversarial reader, not an editor; the run is read-only and the deliverable is findings.",
    signals: [
      /\bsecurity (audit|review|assessment|hardening)\b/,
      /\bvulnerab(le|ility|ilities)\b/,
      /\b(sql ?injection|xss|csrf|ssrf|rce|lfi|object injection)\b/,
      /\bnonce(s)?\b/,
      /\b(capability|capabilities) check\b/,
      /\bcurrent_user_can\b/,
      /\b(escap(e|ing)|sanitiz(e|ation|ing)|unslash)\b/,
      /\b(esc_html|esc_attr|esc_url|wp_kses|sanitize_text_field|wp_verify_nonce|check_admin_referer)\b/,
      /\b(privilege escalation|auth(entication|orization) bypass)\b/,
      /\bharden(ing)?\b/,
    ],
  },
  {
    name: "research",
    implementer: "grok",
    readOnly: true,
    why: "Open questions want breadth and a defended recommendation, not a diff; the run is read-only.",
    signals: [
      /\bresearch\b/,
      /\binvestigate\b/,
      /\b(compare|comparison|evaluate|evaluation) (of |the )?(options|approaches|plugins|libraries|gateways)\b/,
      /\bfeasibilit(y|ies)\b/,
      /\bspike\b/,
      /\bwhich (plugin|library|gateway|approach|host)\b/,
      /\bpros and cons\b/,
      /\btrade[- ]?offs?\b/,
      /\brecommend(ation)? (which|what|an approach)\b/,
    ],
  },
  {
    name: "documentation",
    implementer: "kimi",
    readOnly: false,
    why: "Documentation is high-volume, low-branching prose work — the cheapest capable implementer wins.",
    signals: [
      /\b(write|update|generate|improve) (the )?(docs|documentation)\b/,
      /\breadme(\.txt|\.md)?\b/,
      /\bchangelog\b/,
      /\b(docblock|phpdoc|inline comments)\b/,
      /\b(user|developer|migration|upgrade) guide\b/,
      /\bdocument the\b/,
      /\bcode comments\b/,
    ],
  },
  {
    name: "refactor-sweep",
    implementer: "opencode",
    readOnly: false,
    why: "A wide mechanical sweep needs sustained context across many files more than it needs deep reasoning on any one.",
    signals: [
      /\b(large|big|wide|sweeping|codebase[- ]wide|repo[- ]wide|plugin[- ]wide) refactor\b/,
      /\brefactor(ing)? (the (whole|entire)|all|every)\b/,
      /\brename .* (across|throughout|everywhere)\b/,
      /\b(migrate|convert|port) all\b/,
      /\bacross (all|every) (file|template|module|class)/,
      /\b(restructure|reorganiz(e|ation)) the\b/,
      /\bextract .* into (a )?(class|trait|service|module)\b/,
      /\bnamespace the\b/,
      /\bpsr-4 (migration|conversion)\b/,
      /\bdeprecat(e|ion) sweep\b/,
    ],
  },
  {
    name: "plugin-architecture",
    implementer: "codex",
    readOnly: false,
    why: "Structural design decisions compound; this lane gets the strongest reasoning available.",
    signals: [
      /\bplugin (architecture|structure|scaffold|skeleton|boilerplate)\b/,
      /\b(new|build a|create a|write a) (custom )?plugin\b/,
      /\b(activation|deactivation|uninstall) hook\b/,
      /\bregister_activation_hook\b/,
      /\b(service container|dependency injection|autoload(er|ing))\b/,
      /\bcomposer (package|autoload)\b/,
      /\bmu-plugin\b/,
      /\bchild theme (scaffold|structure|setup)\b/,
      /\btheme (architecture|structure|scaffold)\b/,
      /\bmultisite (architecture|network plugin)\b/,
    ],
  },
  {
    name: "elementor-widget",
    implementer: "codex",
    readOnly: false,
    why: "Elementor's control/render/editor contract is unforgiving; a wrong control schema fails silently in the editor.",
    signals: [
      /\belementor\b/,
      /\bdynamic tag(s)?\b/,
      /\b(loop|theme) builder\b/,
      /\bcustom (widget|control)s?\b/,
      /\bwidget_(controls|render)\b/,
      /\bregister_controls\b/,
      /\b\\?Elementor\\/,
    ],
  },
  {
    name: "performance",
    implementer: "codex",
    readOnly: false,
    why: "Performance work is measurement-driven and easy to get plausibly wrong; it gets the strongest reasoning available.",
    signals: [
      /\b(performance|optimi[sz](e|ation)) (work|pass|audit|task)?\b/,
      /\b(slow|expensive|n\+1) quer(y|ies)\b/,
      /\bobject cache\b/,
      /\b(redis|memcached|opcache)\b/,
      /\bwp[- ]rocket\b/,
      /\blitespeed\b/,
      /\bcloudflare\b/,
      /\b(transient|autoload(ed)? options)\b/,
      /\b(asset|image) optimi[sz]ation\b/,
      /\b(core web vitals|lcp|cls|ttfb)\b/,
      /\bquery monitor\b/,
      /\b(index|indexes|indices) on wp_/,
      /\bcach(e|ing) layer\b/,
    ],
  },
];

// Anything WordPress-shaped that matched no lane. Implementation is the common case,
// so the fallback is an implementer that can carry a normal feature or bugfix brief.
const DEFAULT_LANE = {
  name: "implementation",
  implementer: "codex",
  readOnly: false,
  why: "No lane signal dominated, so the brief is treated as ordinary implementation work.",
  signals: [],
};

/* ------------------------------------------------------------------ *
 * Domain table — what the brief is ABOUT, as opposed to what KIND of work it is.
 *
 * Domains do not pick the implementer. They select the notes appended to the
 * preamble, and they are recorded in result.json so a reviewer can see what the
 * router thought it was looking at. Add a row to teach the preamble a new area.
 * ------------------------------------------------------------------ */
const DOMAINS = [
  {
    name: "core",
    signals: [/\b(add_action|add_filter|do_action|apply_filters)\b/, /\b(hook|filter|action)s?\b/, /\bwp[- ]cli\b/, /\bwp_cron|wp_schedule_event|cron job\b/, /\brest (api|route|endpoint)\b/, /\bregister_rest_route\b/, /\b(gutenberg|block editor|block\.json|classic editor)\b/, /\bmultisite\b/, /\b(i18n|l10n|internationali[sz]ation|localis|localiz)/, /\btext domain\b/, /\b(custom post type|taxonom(y|ies))\b/],
    notes: [
      "Hooks: register on the documented hook, not on `init` by default; respect priority and accepted-args counts.",
      "i18n: every user-facing string goes through a translation function with this plugin's or theme's own text domain, and translator comments accompany any placeholder.",
      "Never edit WordPress core files. Extend through hooks, filters, and the documented APIs.",
    ],
  },
  {
    name: "woocommerce",
    signals: [/\bwoo ?commerce\b/, /\bwc_[a-z_]+\b/, /\b(cart|checkout|order|coupon|shipping (zone|method)|payment gateway)\b/, /\b(product|variation) (type|attribute|field)s?\b/, /\bsubscription(s)? plugin\b/, /\bmembership(s)?\b/, /\bhpos|high[- ]performance order storage\b/],
    notes: [
      "WooCommerce: prefer CRUD objects (`wc_get_order`, `$order->save()`) over direct post/meta access — HPOS makes post-table assumptions wrong.",
      "Cart, checkout, and gateway work must survive a partial or retried request: make writes idempotent and never trust a client-supplied price or total.",
      "Declare compatibility explicitly when a change touches order storage or the checkout block.",
    ],
  },
  {
    name: "elementor",
    signals: [/\belementor\b/, /\bdynamic tag(s)?\b/, /\b(loop|theme) builder\b/, /\bregister_controls\b/, /\bpopup(s)?\b/],
    notes: [
      "Elementor: widgets register controls in `register_controls()` and render in `render()`; editor preview and front-end output must agree.",
      "Escape every control value at output — control input is user input.",
      "Register widgets and dynamic tags on Elementor's own hooks so the plugin degrades cleanly when Elementor is inactive.",
    ],
  },
  {
    name: "acf",
    signals: [/\bacf\b/, /\badvanced custom fields\b/, /\b(flexible content|repeater|relationship field|options page)\b/, /\bget_field|the_field|have_rows\b/, /\bacf[- ]json\b/],
    notes: [
      "ACF: field definitions belong in version control via ACF JSON sync — do not rely on the database as the source of truth.",
      "Guard every `get_field()` call for a missing plugin and a missing value; `have_rows()` loops must be reset.",
      "Reference fields by key, not by label, and escape field output at render.",
    ],
  },
  {
    name: "wpforms",
    signals: [/\bwp ?forms\b/, /\bform (validation|entry|submission)\b/, /\bconditional logic\b/, /\bmulti[- ]step form\b/],
    notes: [
      "WPForms: server-side validation is the real validation — conditional logic and client-side rules are a convenience, not a control.",
      "Entry handlers must verify the nonce and the capability before acting, and sanitize every field on the way in.",
    ],
  },
  {
    name: "performance",
    signals: [/\b(object cache|transient|autoload(ed)? options)\b/, /\b(redis|memcached|opcache)\b/, /\bwp[- ]rocket|litespeed|cloudflare\b/, /\b(slow|expensive|n\+1) quer(y|ies)\b/, /\bcore web vitals|lcp|cls|ttfb\b/],
    notes: [
      "Performance: measure before and after with the same method, and put the numbers in the report. An optimization without a measurement is a guess.",
      "Cache with an explicit invalidation path. A cache nobody clears is a bug with a delay.",
      "Watch autoloaded options: anything large or rarely read should not autoload.",
    ],
  },
  {
    name: "database",
    signals: [/\bwp_(posts|postmeta|options|users|usermeta|terms|termmeta|term_relationships|comments|commentmeta)\b/, /\b(meta_query|tax_query|wp_query|get_posts)\b/, /\b\$wpdb\b/, /\bdbdelta\b/, /\bcustom table\b/, /\b(index|indexes|indices) on\b/, /\b(migration|backfill)\b/],
    notes: [
      "Database: use `$wpdb->prepare()` for every interpolated value — no exceptions, including ORDER BY built from input.",
      "`meta_query` and `tax_query` do not scale; for hot paths prefer a custom table or an indexed column and say so in the report.",
      "Schema changes go through `dbDelta()` with a version-gated upgrade routine, and must be safe to run twice.",
    ],
  },
  {
    name: "security",
    signals: [/\bnonce(s)?\b/, /\bcurrent_user_can\b/, /\b(capability|capabilities) check\b/, /\b(escap(e|ing)|sanitiz(e|ation|ing))\b/, /\b(sql ?injection|xss|csrf|ssrf)\b/, /\b(auth(entication|orization))\b/],
    notes: [
      "Security: every state-changing request verifies a nonce AND a capability. A nonce alone is not authorization.",
      "Sanitize on input, escape on output, at the point of output — late escaping, every time.",
      "Never build SQL by concatenation; never trust `$_POST`, `$_GET`, `$_REQUEST`, or a REST payload unslashed.",
    ],
  },
  {
    name: "integrations",
    signals: [/\b(stripe|paypal|mailchimp|hubspot|zapier|make\.com|n8n)\b/, /\b(openai|claude|anthropic|gemini) api\b/, /\b(aws|azure|s3|lambda)\b/, /\bwebhook(s)?\b/, /\bthird[- ]party api\b/],
    notes: [
      "Integrations: use `wp_remote_*` with an explicit timeout and full error handling — never cURL directly, never assume a 200.",
      "Credentials come from constants or a secrets store, never from the repo, and never get logged.",
      "Webhook endpoints authenticate the caller (signature or shared secret) and are idempotent on replay.",
    ],
  },
  {
    name: "hosting",
    signals: [/\b(apache|nginx|php[- ]fpm)\b/, /\b(cpanel|plesk|cyberpanel|cloudways)\b/, /\b(digitalocean|ec2|lightsail)\b/, /\b(\.htaccess|vhost|server block)\b/],
    notes: [
      "Hosting: keep server configuration out of application logic; state the assumed stack in the report so the reviewer can check it against the real host.",
    ],
  },
  {
    name: "deployment",
    signals: [/\b(ci\/cd|github actions|gitlab ci|bitbucket pipelines)\b/, /\bcomposer\b/, /\bbedrock\b/, /\b(deploy|deployment|rollback)\b/, /\b(backup|restore)\b/, /\bwp[- ]cli\b/],
    notes: [
      "Deployment: every change needs a stated rollback path and a database-migration story, or it is not deployable.",
      "Never ship a step that writes to production without a backup taken in the same run.",
    ],
  },
];

/* ------------------------------------------------------------------ *
 * The preamble — the standing instruction every WordPress brief carries,
 * whichever implementer runs it. Print it with --print-preamble; suppress it
 * with --no-preamble. Domain notes are appended only for detected domains, so
 * the brief stays short.
 * ------------------------------------------------------------------ */
const PREAMBLE = `<wordpress_engineering_standards>
You are implementing inside a WordPress codebase, as a senior WordPress engineer would. These
standards hold for every task and outrank your own defaults where they conflict.

Security is not a feature of the task; it is a property of every line.
  - Verify a nonce AND a capability on every state-changing request. Neither alone is authorization.
  - Sanitize on input, escape on output, at the point of output.
  - Every interpolated SQL value goes through $wpdb->prepare(). No exceptions.
  - Treat $_GET, $_POST, $_REQUEST, $_COOKIE and REST payloads as hostile, and unslash before sanitizing.

Use the platform, do not fight it.
  - Never edit core, and never edit a third-party plugin or theme in place. Extend through hooks,
    filters, and the documented APIs; child themes for theme changes.
  - Prefer an existing WordPress API to a hand-rolled equivalent (HTTP, filesystem, cron, options,
    transients, REST). If you hand-roll one, say why in the report.
  - Enqueue scripts and styles; do not print tags. Register on the documented hook.

Write it so the next person can maintain it.
  - Follow WordPress Coding Standards for the language in play, and match the file you are editing
    over any general rule.
  - Prefix every global function, class, constant, option, and hook name with the project's own prefix.
  - No dead code, no speculative options, no abstraction without a second caller in this diff.

Do not break what already works.
  - Preserve backward compatibility for public hooks, filters, shortcodes, REST routes, and option
    shapes. If a break is unavoidable, deprecate with a shim and call it out in the report.
  - Assume the site has other plugins. Guard every dependency on one, and degrade cleanly when it is
    absent or a different major version.
  - State the minimum PHP and WordPress versions your change assumes if it is above the project's.

Performance is measured, not asserted.
  - Never query inside a loop when a single batched query will do; never add an unbounded query.
  - Cache with an explicit invalidation path, and keep large values out of autoloaded options.

Verification and reporting.
  - Run the project's real gates and fix what they surface. Do not report a failure as done.
  - Do NOT run git add or git commit. Leave the work uncommitted; the orchestrator reviews and commits.
  - If a required fact about the site, stack, or plugin versions is missing, find it in the working
    tree or state plainly that it is unknown. Do not guess and do not invent an API.
</wordpress_engineering_standards>`;

function fail(message, code = 2) {
  process.stderr.write(`relay: ${message}\n`);
  process.exit(code);
}

function headerComment() {
  // The leading block comment doubles as --help text.
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (!match) return "relay.mjs — route a WordPress brief to a sibling delegate\n";
  return match[1].replace(/^\s*\* ?/gm, "").trim() + "\n";
}

function parseArgs(argv) {
  const opts = {
    brief: null,
    cd: process.cwd(),
    model: null,
    implementer: null,
    lane: null,
    strictRouting: false,
    dryRun: false,
    preamble: true,
    readOnly: false,
    session: null,
    resumeLast: false,
    timeout: null,
    outDir: null,
    implementerRelay: null,
    passthrough: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(headerComment());
        process.exit(0);
        break;
      case "--list-routes":
        process.stdout.write(renderRoutes());
        process.exit(0);
        break;
      case "--print-preamble":
        process.stdout.write(`${PREAMBLE}\n`);
        process.exit(0);
        break;
      case "--brief": opts.brief = next(); break;
      case "--cd": opts.cd = resolve(next()); break;
      case "--model": opts.model = next(); break;
      case "--implementer": opts.implementer = next(); break;
      case "--lane": opts.lane = next(); break;
      case "--strict-routing": opts.strictRouting = true; break;
      case "--dry-run": opts.dryRun = true; break;
      case "--no-preamble": opts.preamble = false; break;
      case "--read-only": opts.readOnly = true; break;
      case "--session": opts.session = next(); break;
      case "--resume-last": opts.resumeLast = true; break;
      case "--timeout": opts.timeout = next(); break;
      case "--out-dir": opts.outDir = resolve(next()); break;
      case "--implementer-relay": opts.implementerRelay = resolve(next()); break;
      case "--":
        opts.passthrough = argv.slice(i + 1);
        i = argv.length;
        break;
      default:
        fail(`unknown option: ${arg}`);
    }
  }
  if (opts.implementer !== null && !Object.hasOwn(IMPLEMENTERS, opts.implementer)) {
    fail(`unknown --implementer "${opts.implementer}" (expected: ${Object.keys(IMPLEMENTERS).join(", ")})`);
  }
  if (opts.lane !== null && !laneByName(opts.lane)) {
    fail(`unknown --lane "${opts.lane}" (expected: ${[...LANES, DEFAULT_LANE].map((l) => l.name).join(", ")})`);
  }
  // The sibling validates --timeout too, but it must be rejected here as well: this relay
  // arms a backstop timer from the same value, and a malformed duration would otherwise fire
  // on the next tick as a silent instant "timeout" before the sibling ever spoke.
  if (opts.timeout !== null && parseDuration(opts.timeout) === null) {
    fail(`--timeout "${opts.timeout}" is invalid or too long; use a positive h/m/s duration no longer than about 24 days`);
  }
  if (opts.session !== null && opts.resumeLast) {
    fail("--session and --resume-last are mutually exclusive; pass only one");
  }
  return opts;
}

function parseDuration(duration) {
  // Whole-string match: "1mtypo" must be rejected, not read as one minute. The accepted range is
  // exactly a sibling's, so a duration this relay forwards is never one the sibling then rejects.
  // The backstop's own grace is clamped at schedule time rather than subtracted here, which would
  // otherwise make the largest sibling-legal duration a usage error at this layer only.
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(duration);
  if (!match || (!match[1] && !match[2] && !match[3])) return null;
  try {
    const seconds = BigInt(match[1] || 0) * 3600n + BigInt(match[2] || 0) * 60n + BigInt(match[3] || 0);
    const milliseconds = seconds * 1000n;
    if (milliseconds <= 0n || milliseconds > BigInt(MAX_TIMER_MS)) return null;
    return Number(milliseconds);
  } catch {
    return null;
  }
}

function laneByName(name) {
  return [...LANES, DEFAULT_LANE].find((l) => l.name === name) || null;
}

function renderRoutes() {
  const lines = ["Lanes (first match wins on a tie — order is precedence):", ""];
  for (const lane of [...LANES, DEFAULT_LANE]) {
    lines.push(`  ${lane.name.padEnd(20)} -> ${lane.implementer}${lane.readOnly ? "  (read-only)" : ""}`);
    lines.push(`  ${" ".repeat(20)}    ${lane.why}`);
    lines.push("");
  }
  lines.push("Implementers:", "");
  for (const [name, impl] of Object.entries(IMPLEMENTERS)) {
    lines.push(`  ${name.padEnd(10)} ${impl.note}`);
    lines.push(`  ${" ".repeat(10)} read-only: ${impl.readOnly ? impl.readOnly.join(" ") : "unsupported"}  ·  resume: ${impl.sessionFlag} <id>${impl.requiresModel ? "  ·  --model required" : ""}`);
    lines.push("");
  }
  lines.push("Extend routing by adding a row to LANES in this file; nothing else knows the lane names.");
  return `${lines.join("\n")}\n`;
}

/* ------------------------------------------------------------------ *
 * Classification.
 * ------------------------------------------------------------------ */
function matchedSignals(signals, text) {
  const hits = [];
  for (const signal of signals) {
    const found = signal.exec(text);
    if (found) hits.push(found[0].trim());
  }
  return hits;
}

function detectDomains(text) {
  return DOMAINS.filter((d) => d.signals.some((s) => s.test(text))).map((d) => d.name);
}

function classify(brief, opts) {
  const text = brief.toLowerCase();
  const domains = detectDomains(text);

  if (opts.implementer && !opts.lane) {
    return {
      lane: "(forced)",
      implementer: opts.implementer,
      confidence: "forced",
      why: "--implementer was given, so the lane table was not consulted.",
      matchedSignals: [],
      alternates: [],
      domains,
      laneReadOnly: false,
    };
  }

  if (opts.lane) {
    const lane = laneByName(opts.lane);
    return {
      lane: lane.name,
      implementer: opts.implementer || lane.implementer,
      confidence: "forced",
      why: opts.implementer
        ? `--lane and --implementer were both given; the lane's own target (${lane.implementer}) was overridden.`
        : lane.why,
      matchedSignals: matchedSignals(lane.signals, text),
      alternates: [],
      domains,
      laneReadOnly: lane.readOnly,
    };
  }

  const scored = LANES
    .map((lane) => ({ lane, hits: matchedSignals(lane.signals, text) }))
    .filter((entry) => entry.hits.length > 0);
  // Stable sort by score keeps LANES order as the tie-break, which is deliberate:
  // lane order encodes precedence, so a brief that trips security and performance
  // alike is routed as security.
  scored.sort((a, b) => b.hits.length - a.hits.length);

  if (scored.length === 0) {
    return {
      lane: DEFAULT_LANE.name,
      implementer: DEFAULT_LANE.implementer,
      confidence: "none",
      why: DEFAULT_LANE.why,
      matchedSignals: [],
      alternates: [],
      domains,
      laneReadOnly: DEFAULT_LANE.readOnly,
    };
  }

  const [winner, ...rest] = scored;
  const contested = rest.some((entry) => entry.hits.length === winner.hits.length);
  const confidence = contested ? "contested" : winner.hits.length >= 2 ? "high" : "low";

  // A read-only lane on one weak signal is the worst failure this router has: the run comes back
  // with findings and an empty diff, and the caller who asked for a fix reads that as the
  // implementer doing nothing. One mention of "nonce" in a bugfix brief is not an audit request, so
  // a lone signal demotes to the implementation fallback rather than silently withholding writes.
  // A tie is left alone — "contested" already names both lanes and asks.
  if (winner.lane.readOnly && confidence === "low") {
    return {
      lane: DEFAULT_LANE.name,
      implementer: DEFAULT_LANE.implementer,
      confidence: "low",
      why: `only one signal matched the read-only ${winner.lane.name} lane, which is too weak to withhold writes; treated as implementation work instead`,
      matchedSignals: winner.hits,
      alternates: [{ lane: winner.lane.name, implementer: winner.lane.implementer, score: winner.hits.length }],
      domains,
      laneReadOnly: false,
    };
  }

  return {
    lane: winner.lane.name,
    implementer: winner.lane.implementer,
    confidence,
    why: winner.lane.why,
    matchedSignals: winner.hits,
    alternates: rest.slice(0, 3).map((entry) => ({
      lane: entry.lane.name,
      implementer: entry.lane.implementer,
      score: entry.hits.length,
    })),
    domains,
    laneReadOnly: winner.lane.readOnly,
  };
}

function clarificationQuestion(routing) {
  if (routing.confidence === "contested") {
    const options = [routing.lane, ...routing.alternates.map((a) => a.lane)].join(" or ");
    return `the brief matches several lanes equally (${options}); ask the user which one this task is, or pass --lane`;
  }
  if (routing.confidence === "low") {
    return `only one weak signal matched (${routing.matchedSignals.join(", ") || "none"}); ask the user what kind of work this is, or pass --lane/--implementer`;
  }
  return "no lane signal matched; ask the user what kind of work this is, or pass --lane/--implementer";
}

function capabilityBlocker(routing, opts) {
  // The two mismatches that would otherwise surface as a bare "unknown option" from the sibling,
  // which reads like a bug in this relay rather than a property of the chosen CLI.
  const impl = IMPLEMENTERS[routing.implementer];
  if ((opts.readOnly || routing.laneReadOnly) && !impl.readOnly) {
    return `${routing.implementer} has no read-only mode, so this run cannot be one` +
      `${routing.laneReadOnly ? ` (lane ${routing.lane} is read-only by default)` : ""}. ` +
      "Route to an implementer that has one (--implementer codex), or drop --read-only and rely on touchedFiles.";
  }
  if (impl.requiresModel && opts.model === null) {
    return `${routing.implementer} requires an explicit model; pass --model <name> (lane ${routing.lane} routes here)`;
  }
  return null;
}

function composeBrief(brief, routing, opts) {
  // A resumed session already carries the preamble in its context; re-sending it would
  // spend tokens restating standards the implementer has already been given.
  if (!opts.preamble || opts.session || opts.resumeLast) return brief;
  const notes = DOMAINS.filter((d) => routing.domains.includes(d.name)).flatMap((d) => d.notes);
  const blocks = [PREAMBLE];
  if (notes.length) {
    blocks.push([
      "<domain_notes>",
      `Detected in this brief: ${routing.domains.join(", ")}. These are a hint from a keyword scan, not`,
      "a survey of the working tree — verify each against the actual code before relying on it.",
      ...notes.map((n) => `  - ${n}`),
      "</domain_notes>",
    ].join("\n"));
  }
  blocks.push(brief.trim());
  return `${blocks.join("\n\n")}\n`;
}

/* ------------------------------------------------------------------ *
 * Dispatch.
 * ------------------------------------------------------------------ */
function readBrief(opts) {
  if (opts.brief) {
    if (!existsSync(opts.brief)) fail(`brief file not found: ${opts.brief}`);
    return readFileSync(opts.brief, "utf8");
  }
  if (process.stdin.isTTY) {
    fail("no --brief given and stdin is a TTY; pass --brief <file> or pipe the brief on stdin");
  }
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function resolveSiblingRelay(implementer, opts) {
  if (opts.implementerRelay) return opts.implementerRelay;
  // Siblings live beside this skill: skills/<x>-delegate/scripts/relay.mjs, and the Skills CLI
  // preserves that layout when it installs the package into an agent directory.
  return join(here, "..", "..", IMPLEMENTERS[implementer].dir, "scripts", "relay.mjs");
}

function killChild(child, signal = "SIGTERM") {
  // The kill must reach the whole family: this relay's child is another relay, whose own child
  // is the implementer CLI, whose children are its tools. Same idiom as every sibling relay.
  if (process.platform === "win32") {
    if (signal !== "SIGTERM") return; // the first taskkill /f already felled the whole tree
    try { execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: ["ignore", "ignore", "inherit"] }); }
    catch { /* already gone — nothing left to kill */ }
  } else {
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
  }
}

function gitTouchedFiles(cwd) {
  // null (not []) when git can't report, so the caller can tell "git unavailable" apart from
  // "the implementer changed nothing". Only used as a fallback: on any run where the sibling
  // wrote a result, its own snapshot is the authoritative one.
  try {
    const out = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return out.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  } catch {
    return null;
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function prepareRunDir(opts, brief, routing) {
  const startedAt = new Date().toISOString();
  const outDir = opts.outDir || join(tmpdir(), "delegate-relay", `${basename(opts.cd) || "repo"}-wordpress-${timestamp()}`);
  const implOutDir = join(outDir, "implementer");
  mkdirSync(implOutDir, { recursive: true });
  const run = {
    startedAt,
    outDir,
    implOutDir,
    briefPath: join(outDir, "dispatched-brief.txt"),
    resultPath: join(outDir, "result.json"),
    implResultPath: join(implOutDir, "result.json"),
  };
  writeFileSync(run.briefPath, composeBrief(brief, routing, opts), "utf8");
  return run;
}

function makeResultWriter(opts, routing, run, relayPath) {
  return (extra) => {
    const result = {
      schema: "delegate-relay.result.v1",
      workdir: opts.cd,
      routing: {
        lane: routing.lane,
        implementer: routing.implementer,
        confidence: routing.confidence,
        reason: routing.why,
        matchedSignals: routing.matchedSignals,
        domains: routing.domains,
        alternates: routing.alternates,
        forced: routing.confidence === "forced",
      },
      implementer: routing.implementer,
      implementerRelay: relayPath,
      implementerResultPath: existsSync(run.implResultPath) ? run.implResultPath : null,
      preamble: opts.preamble && !opts.session && !opts.resumeLast,
      readOnly: opts.readOnly || routing.laneReadOnly,
      model: opts.model,
      session: opts.session,
      resumeLast: opts.resumeLast,
      startedAt: run.startedAt,
      finishedAt: new Date().toISOString(),
      briefPath: run.briefPath,
      ...extra,
    };
    // Publish atomically so a polling orchestrator never reads a half-written file.
    const temporary = `${run.resultPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    renameSync(temporary, run.resultPath);
    return result;
  };
}

function readImplementerResult(run) {
  if (!existsSync(run.implResultPath)) return null;
  try {
    return JSON.parse(readFileSync(run.implResultPath, "utf8"));
  } catch {
    // A sibling killed mid-write leaves nothing parseable. Every sibling publishes atomically,
    // so this is close to unreachable — but a corrupt file must not mask the run's outcome.
    return null;
  }
}

function liftSessionId(implResult) {
  if (!implResult) return null;
  return implResult.sessionId ?? implResult.threadId ?? implResult.conversationId ?? null;
}

function reportRelayMissing(opts, routing, run, relayPath) {
  const writeResult = makeResultWriter(opts, routing, run, relayPath);
  const result = writeResult({
    status: "implementer_unavailable",
    exitCode: 127,
    signal: null,
    finalMessage: "",
    touchedFiles: null,
    implementerSession: null,
    implementerResult: null,
    error: `the ${routing.implementer}-delegate relay was not found at ${relayPath}; wordpress-delegate dispatches through its siblings and cannot run alone`,
  });
  printSummary(result, run.resultPath);
  process.stderr.write(
    `relay: ${routing.implementer}-delegate is not installed beside this skill.\n` +
    `       Install it (npx skills add amElnagdy/delegate-skills --skill ${IMPLEMENTERS[routing.implementer].dir}),\n` +
    `       or point --implementer-relay at its scripts/relay.mjs, or route elsewhere with --implementer.\n`,
  );
  process.exit(127);
}

function implementerFlags(routing, opts) {
  // The only part of the sibling command line that differs by implementer: this relay's portable
  // --read-only and --session are spelled in the chosen CLI's own terms. Exposed by --dry-run so
  // the translation is inspectable without launching anything.
  const impl = IMPLEMENTERS[routing.implementer];
  const flags = [];
  if ((opts.readOnly || routing.laneReadOnly) && impl.readOnly) flags.push(...impl.readOnly);
  if (opts.session !== null) flags.push(impl.sessionFlag, opts.session);
  if (opts.resumeLast) flags.push("--resume-last");
  return flags;
}

function buildSiblingArgv(relayPath, opts, routing, run) {
  const argv = [relayPath, "--brief", run.briefPath, "--cd", opts.cd, "--out-dir", run.implOutDir];
  if (opts.timeout !== null) argv.push("--timeout", opts.timeout);
  if (opts.model !== null) argv.push("--model", opts.model);
  argv.push(...implementerFlags(routing, opts));
  argv.push(...opts.passthrough);
  return argv;
}

function dispatchToSibling(opts, routing, run, relayPath, writeResult) {
  const argv = buildSiblingArgv(relayPath, opts, routing, run);
  // The sibling is a Node script, so it is launched with this process's own interpreter —
  // no PATH lookup, no shell, and no Windows .cmd shim to resolve. detached on POSIX so the
  // sibling leads its own process group and killChild can fell the whole family.
  const child = spawn(process.execPath, argv, {
    cwd: opts.cd,
    stdio: ["ignore", "inherit", "inherit"],
    detached: process.platform !== "win32",
  });

  let settled = false;
  let backstopFired = false;
  let aborting = null;
  let backstopTimer = null;
  let sigkillTimer = null;
  const timeoutMs = opts.timeout === null ? null : parseDuration(opts.timeout);

  if (timeoutMs !== null) {
    // Clamp rather than overflow: a delay past 2^31-1 ms wraps and fires on the next tick,
    // which would report a 24-day budget as already spent.
    const backstopMs = Math.min(timeoutMs + BACKSTOP_GRACE_MS, MAX_TIMER_MS);
    backstopTimer = setTimeout(() => {
      backstopFired = true;
      killChild(child);
      sigkillTimer = setTimeout(() => { if (!settled) killChild(child, "SIGKILL"); }, 10_000);
    }, backstopMs);
  }

  const clearTimers = () => {
    if (backstopTimer) clearTimeout(backstopTimer);
    if (sigkillTimer) clearTimeout(sigkillTimer);
  };

  // This relay's own death must still produce a result. Unlike a sibling, it does not have to
  // synthesize one: it forwards the signal and lets the sibling write its own, then lifts it.
  // The sibling refreshes its touched-files snapshot ~2s into its shutdown, so the grace window
  // here is longer than that — cutting it short would publish a stale file list.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      if (settled || aborting) return;
      aborting = sig;
      clearTimers();
      killChild(child);
      sigkillTimer = setTimeout(() => { if (!settled) killChild(child, "SIGKILL"); }, SIBLING_SHUTDOWN_GRACE_MS);
    });
  }

  child.on("error", (err) => {
    if (settled) return;
    settled = true;
    clearTimers();
    const result = writeResult({
      status: "failed",
      exitCode: 1,
      signal: null,
      finalMessage: "",
      touchedFiles: gitTouchedFiles(opts.cd),
      implementerSession: null,
      implementerResult: null,
      error: `could not launch the ${routing.implementer}-delegate relay: ${String(err && err.message ? err.message : err)}`,
    });
    printSummary(result, run.resultPath);
    process.exit(1);
  });

  child.on("close", (code, signal) => {
    if (settled) return;
    settled = true;
    clearTimers();
    // A descendant that ignored SIGTERM must not outlive the report.
    if (backstopFired || aborting) killChild(child, "SIGKILL");

    const implResult = readImplementerResult(run);
    const mapped = code ?? (constants.signals[signal] ? 128 + constants.signals[signal] : 1);

    // The sibling's own result is the authority whenever it managed to write one: it saw the
    // implementer's exit, its final message, and the working tree at the right moment. This
    // relay only overrides the verdict where it did the killing and the sibling could not know.
    let status;
    let exitCode;
    let error;
    if (backstopFired) {
      status = "timeout";
      exitCode = mapped === 0 ? 1 : mapped;
      error = `the ${routing.implementer}-delegate relay did not finish within --timeout ${opts.timeout} plus a ${BACKSTOP_GRACE_MS / 1000}s backstop; killed by the wordpress-delegate watchdog`;
    } else if (aborting && (!implResult || implResult.status !== "aborted")) {
      status = "aborted";
      exitCode = 128 + (constants.signals[aborting] || 15);
      error = `the relay was killed by ${aborting}; the ${routing.implementer}-delegate relay was terminated with it — inspect the working tree before re-dispatching`;
    } else if (implResult) {
      status = implResult.status;
      exitCode = Number.isInteger(implResult.exitCode) ? implResult.exitCode : mapped;
      error = implResult.error;
    } else {
      status = "failed";
      exitCode = mapped === 0 ? 1 : mapped;
      error = `the ${routing.implementer}-delegate relay exited ${mapped} without writing a result file; this is usually a usage error in the forwarded arguments — check the relay output above`;
    }

    const result = writeResult({
      status,
      exitCode,
      signal: implResult?.signal ?? signal ?? null,
      finalMessage: implResult?.finalMessage ?? "",
      touchedFiles: implResult ? implResult.touchedFiles : gitTouchedFiles(opts.cd),
      implementerSession: liftSessionId(implResult),
      implementerResult: implResult,
      ...(implResult?.stderrTail ? { stderrTail: implResult.stderrTail } : {}),
      ...(error ? { error } : {}),
    });
    printSummary(result, run.resultPath);
    process.exit(result.exitCode);
  });
}

function printSummary(result, resultPath) {
  const lines = [];
  lines.push("");
  lines.push(`relay: ${result.status} (exit ${result.exitCode}${result.signal ? `, killed by ${result.signal}` : ""})  ·  wordpress → ${result.implementer}`);
  lines.push(`routing: lane ${result.routing.lane} → ${result.routing.implementer} (confidence: ${result.routing.confidence})`);
  lines.push(`  why: ${result.routing.reason}`);
  if (result.routing.matchedSignals.length) lines.push(`  matched: ${result.routing.matchedSignals.join(", ")}`);
  if (result.routing.domains.length) lines.push(`  domains: ${result.routing.domains.join(", ")}`);
  if (result.routing.alternates.length) {
    lines.push(`  runners-up: ${result.routing.alternates.map((a) => `${a.lane} (${a.score})`).join(", ")}`);
  }
  if (result.routing.confidence === "low" || result.routing.confidence === "none" || result.routing.confidence === "contested") {
    lines.push("  note: routing was not confident. Re-read the diff against what the user actually asked for,");
    lines.push("        and consider re-dispatching with --lane or --implementer.");
  }
  if (result.readOnly) lines.push("mode: read-only — the diff should be empty; verify touchedFiles, do not assume");
  if (result.implementerSession) lines.push(`implementer session (resume with: --session ${result.implementerSession}): ${result.implementerSession}`);
  const touched = result.touchedFiles;
  if (touched === null) {
    lines.push("touched files: git unavailable — inspect the working tree directly");
  } else {
    lines.push(`touched files: ${touched.length}`);
    for (const file of touched.slice(0, 40)) lines.push(`  ${file}`);
    if (touched.length > 40) lines.push(`  … and ${touched.length - 40} more`);
  }
  if (result.stderrTail && result.stderrTail.length) {
    lines.push("last stderr:");
    for (const line of result.stderrTail.slice(-8)) lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push(`--- ${result.implementer} final report ---`);
  lines.push(result.finalMessage || "(no final message captured)");
  lines.push("--- end report ---");
  lines.push("");
  lines.push(`result: ${resultPath}`);
  if (result.implementerResultPath) lines.push(`implementer result: ${result.implementerResultPath}`);
  lines.push("relay does not commit. Review the diff, re-run the project gates yourself, then commit from the orchestrator.");
  process.stdout.write(`${lines.join("\n")}\n`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const brief = readBrief(opts);
  if (!brief.trim()) fail("empty brief (pass --brief <file> or pipe the brief on stdin)");

  const routing = classify(brief, opts);

  if (opts.strictRouting && ["low", "none", "contested"].includes(routing.confidence)) {
    process.stderr.write(`relay: --strict-routing refused to dispatch — ${clarificationQuestion(routing)}\n`);
    process.exit(3);
  }

  const blocker = capabilityBlocker(routing, opts);

  // --dry-run reports the decision, including a blocker, rather than exiting on one: the point
  // of the flag is to see where a brief would go, and "it would go to opencode, which needs a
  // --model you did not pass" is exactly the answer being asked for.
  if (opts.dryRun) {
    process.stdout.write(`${JSON.stringify({
      lane: routing.lane,
      implementer: routing.implementer,
      confidence: routing.confidence,
      reason: routing.why,
      matchedSignals: routing.matchedSignals,
      domains: routing.domains,
      alternates: routing.alternates,
      readOnly: opts.readOnly || routing.laneReadOnly,
      implementerFlags: implementerFlags(routing, opts),
      clarification: ["low", "none", "contested"].includes(routing.confidence) ? clarificationQuestion(routing) : null,
      blocker,
    }, null, 2)}\n`);
    process.exit(0);
  }

  if (blocker) fail(blocker);

  const relayPath = resolveSiblingRelay(routing.implementer, opts);
  const run = prepareRunDir(opts, brief, routing);

  if (!existsSync(relayPath)) {
    reportRelayMissing(opts, routing, run, relayPath);
    return;
  }

  const writeResult = makeResultWriter(opts, routing, run, relayPath);
  dispatchToSibling(opts, routing, run, relayPath, writeResult);
}

main();
