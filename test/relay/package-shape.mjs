import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Utility skills: not *-delegate, no relay.mjs / four-reference contract. */
const UTILITY_SKILLS = ["delegate-setup"];

export function runPackageShape(h) {
  const skillsDir = join(h.testDir, "..", "skills");
  const onDiskDelegate = readdirSync(skillsDir).filter((d) => d.endsWith("-delegate")).sort();
  const onDiskUtility = readdirSync(skillsDir).filter((d) => UTILITY_SKILLS.includes(d)).sort();
  const registered = new Set(
    JSON.parse(readFileSync(join(h.testDir, "..", "skills.sh.json"), "utf8"))
      .groupings.flatMap((g) => g.skills),
  );
  const REFERENCES = ["writing-the-brief", "dispatch-and-poll", "review-and-land", "multi-task-queues"];

  h.check("skills/ is not empty", onDiskDelegate.length > 0);
  for (const dir of onDiskDelegate) {
    const name = dir.replace(/-delegate$/, "");
    h.check(`${name}: in the smoke matrix`, h.SKILLS.includes(name));
    h.check(`${name}: SKILL.md`, existsSync(join(skillsDir, dir, "SKILL.md")));
    h.check(`${name}: scripts/relay.mjs`, existsSync(join(skillsDir, dir, "scripts", "relay.mjs")));
    h.check(
      `${name}: exactly the four references`,
      REFERENCES.every((r) => existsSync(join(skillsDir, dir, "references", `${r}.md`))) &&
        readdirSync(join(skillsDir, dir, "references")).filter((f) => f.endsWith(".md")).length === REFERENCES.length,
    );
    h.check(`${name}: listed in skills.sh.json`, registered.has(dir));
  }
  for (const dir of UTILITY_SKILLS) {
    h.check(`${dir}: directory present`, existsSync(join(skillsDir, dir)));
    h.check(`${dir}: SKILL.md`, existsSync(join(skillsDir, dir, "SKILL.md")));
    h.check(`${dir}: no relay.mjs`, !existsSync(join(skillsDir, dir, "scripts", "relay.mjs")));
    h.check(`${dir}: listed in skills.sh.json`, registered.has(dir));
    h.check(`${dir}: in the utility carve-out`, onDiskUtility.includes(dir));
  }
  h.check("smoke matrix has no entry without a directory", h.SKILLS.every((s) => onDiskDelegate.includes(`${s}-delegate`)));
  h.check(
    "skills.sh.json has no entry without a directory",
    [...registered].every((s) => existsSync(join(skillsDir, s))),
  );
  h.check(
    "no unexpected skill directories",
    readdirSync(skillsDir).every(
      (d) => d.endsWith("-delegate") || UTILITY_SKILLS.includes(d),
    ),
  );
}
