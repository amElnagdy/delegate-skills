import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Utility skills: not *-delegate, no relay.mjs / four-reference contract. */
const UTILITY_SKILLS = ["delegate-setup"];

function metadataVersion(source) {
  const lines = source.split(/\r?\n/);
  if (lines[0] !== "---") return "(missing)";
  const frontmatterEnd = lines.indexOf("---", 1);
  if (frontmatterEnd === -1) return "(missing)";
  const frontmatter = lines.slice(1, frontmatterEnd);
  const metadataAt = frontmatter.findIndex((line) => /^metadata: *$/.test(line));
  if (metadataAt === -1) return "(missing)";
  for (const line of frontmatter.slice(metadataAt + 1)) {
    if (line && !line.startsWith(" ")) break;
    const match = line.match(/^ +version: *(?:"([^"]+)"|'([^']+)'|(\S+)) *$/);
    if (match) return match.slice(1).find(Boolean) ?? "(missing)";
  }
  return "(missing)";
}

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
  const metadataVersions = [...onDiskDelegate, ...onDiskUtility].map((dir) => {
    const skillFile = join(skillsDir, dir, "SKILL.md");
    return existsSync(skillFile)
      ? metadataVersion(readFileSync(skillFile, "utf8"))
      : "(missing)";
  });
  h.check(
    "metadata.version ignores Markdown body snippets",
    metadataVersion("---\nname: example\n---\n\nmetadata:\n  version: 9.9.9\n") === "(missing)",
  );
  h.check(
    "metadata.version accepts ordering, indentation, and quoted scalars",
    [
      "---\nmetadata:\n owner: package\n version: '0.4.2'\n---\n",
      "---\nmetadata:\n    owner: package\n    version: \"0.4.2\"\n---\n",
    ].every((source) => metadataVersion(source) === "0.4.2"),
  );
  h.check(
    "all skill metadata.version values are present and in lockstep",
    !metadataVersions.includes("(missing)") && new Set(metadataVersions).size === 1,
  );
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
