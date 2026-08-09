import { runPackageShape } from "./package-shape.mjs";
import { runSyntax } from "./syntax.mjs";
import { runCodex } from "./codex.mjs";
import { runCursor } from "./cursor.mjs";
import { runVibe } from "./vibe.mjs";
import { runAtomic } from "./atomic.mjs";
import { runPreflight } from "./preflight.mjs";
import { runTimeoutBounds } from "./timeout-bounds.mjs";
import { runQoder } from "./qoder.mjs";
import { runPi } from "./pi.mjs";
import { runClaude } from "./claude.mjs";
import { runTimeoutTree } from "./timeout-tree.mjs";
import { runAbort } from "./abort.mjs";
import { runDelegateSetup } from "./delegate-setup.mjs";

export const runners = [
  ["package-shape", runPackageShape],
  ["syntax", runSyntax],
  ["codex", runCodex],
  ["cursor", runCursor],
  ["vibe", runVibe],
  ["atomic", runAtomic],
  ["preflight", runPreflight],
  ["timeout-bounds", runTimeoutBounds],
  ["qoder", runQoder],
  ["pi", runPi],
  ["claude", runClaude],
  ["timeout-tree", runTimeoutTree],
  ["abort", runAbort],
  ["delegate-setup", runDelegateSetup],
];
