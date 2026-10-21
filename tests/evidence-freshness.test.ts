import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
// The date checks below depend on the wall clock, so they would turn every
// PR red the day a citation ages out, whatever the PR changed. They run on a
// schedule instead (.github/workflows/evidence-freshness.yml) and on demand
// with PLUGINPACK_CHECK_FRESHNESS=1.
const checkFreshness = process.env.PLUGINPACK_CHECK_FRESHNESS === "1";
const CADENCE_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;
const REFRESH =
  "Re-open the cited docs or re-fetch and diff the schemas, verify the claims, then update verifiedAt / Verified-at. See CONFORMANCE.md#evidence-refresh-cadence.";

function freshnessProblem(date: string, today: number): string | undefined {
  const verified = Date.parse(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(verified) ||
    new Date(verified).toISOString().slice(0, 10) !== date
  ) {
    return `invalid verification date "${date}"`;
  }
  const age = Math.floor(today / DAY) - Math.floor(verified / DAY);
  if (age < 0) return `verification date ${date} is in the future`;
  if (age > CADENCE_DAYS)
    return `verification date ${date} is ${age} days old (cadence: ${CADENCE_DAYS} days)`;
  return undefined;
}

it("rejects stale, future, and invalid evidence dates at the 90-day boundary", () => {
  const today = Date.parse("2026-10-21T12:00:00Z");
  expect(freshnessProblem("2026-07-23", today)).toBeUndefined();
  expect(freshnessProblem("2026-07-22", today)).toContain("91 days old");
  expect(freshnessProblem("2026-10-22", today)).toContain("future");
  expect(freshnessProblem("2026-02-30", today)).toContain("invalid");
});

it.runIf(checkFreshness)(
  "keeps every source citation verifiedAt within the documented cadence",
  async () => {
    const problems: string[] = [];
    let citations = 0;
    for (const file of await readdir(path.join(root, "src"), {
      recursive: true,
    })) {
      if (!file.endsWith(".ts")) continue;
      const contents = await readFile(path.join(root, "src", file), "utf8");
      for (const match of contents.matchAll(/verifiedAt:\s*"([^"]+)"/g)) {
        citations++;
        const problem = freshnessProblem(match[1], Date.now());
        if (problem) problems.push(`src/${file}: ${problem}. ${REFRESH}`);
      }
    }
    expect(citations).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  },
);

it.runIf(checkFreshness)(
  "keeps each vendored schema's SOURCE.md verification date within the same cadence",
  async () => {
    const problems: string[] = [];
    for (const format of ["cursor", "agent-plugins"]) {
      const source = `tests/fixtures/${format}/SOURCE.md`;
      const contents = await readFile(path.join(root, source), "utf8");
      const date = /^- Verified-at: (\S+)$/m.exec(contents)?.[1];
      const schemas = (
        await readdir(path.join(root, "tests/fixtures", format))
      ).filter((file) => file.endsWith(".schema.json"));
      expect(schemas.length).toBeGreaterThan(0);
      for (const schema of schemas) {
        const problem = date
          ? freshnessProblem(date, Date.now())
          : "missing Verified-at: YYYY-MM-DD in SOURCE.md";
        if (problem)
          problems.push(`${source} (${schema}): ${problem}. ${REFRESH}`);
      }
    }
    expect(problems).toEqual([]);
  },
);

it("documents the cadence the scheduled check enforces", async () => {
  expect(await readFile(path.join(root, "CONFORMANCE.md"), "utf8")).toContain(
    `Re-verify every citation and vendored schema at least every ${CADENCE_DAYS} days.`,
  );
});
