import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it, vi } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const release = readFileSync(path.join(root, "RELEASE.md"), "utf8");

// Exercise the actual github-script body with API responses, not a second
// implementation of the workflow. No network or GitHub credentials are needed.
const workflow = load(
  readFileSync(path.join(root, ".github/workflows/pr-label.yml"), "utf8"),
) as { jobs: { labels: { steps: { with: { script: string } }[] } } };
const script = workflow.jobs.labels.steps[0].with.script;
const runLabelCheck = new Function(
  "context",
  "github",
  "core",
  `return (async () => { ${script} })();`,
) as (context: object, github: object, core: object) => Promise<void>;

async function checkLabels(labels: string[], authorType = "User") {
  const core = { info: vi.fn(), warning: vi.fn(), setFailed: vi.fn() };
  const listLabelsForRepo = vi.fn();
  const paginate = vi.fn(async (_method, _params, map) => [
    ...map({ data: [{ name: "question" }, { name: "bug" }] }),
    ...map({ data: [{ name: "enhancement" }] }),
  ]);
  await runLabelCheck(
    {
      repo: { owner: "example", repo: "plugins" },
      payload: {
        pull_request: {
          user: { type: authorType, login: "author" },
          labels: labels.map((name) => ({ name })),
        },
      },
    },
    { paginate, rest: { issues: { listLabelsForRepo } } },
    core,
  );
  return { core, paginate, listLabelsForRepo };
}

describe("PR label check", () => {
  it("still derives accepted labels from the paginated repository catalog", async () => {
    const { core, paginate, listLabelsForRepo } = await checkLabels([
      "enhancement",
    ]);
    expect(paginate).toHaveBeenCalledWith(
      listLabelsForRepo,
      { owner: "example", repo: "plugins", per_page: 100 },
      expect.any(Function),
    );
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.warning).not.toHaveBeenCalled();
  });

  it("does not silently pass a label lerna-changelog does not render", async () => {
    const { core } = await checkLabels(["question"]);
    // #33 deliberately accepts every repository label, not just changelog
    // categories. Warn without changing which labels the gate accepts.
    expect(core.setFailed).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining("will not appear in the changelog"),
    );
  });

  it("keeps the warning's rendered-label list in sync with lerna-changelog", async () => {
    const require = createRequire(import.meta.url);
    const { fromPath } = require("lerna-changelog/lib/configuration.js") as {
      fromPath: (root: string) => { labels: Record<string, string> };
    };
    const { core } = await checkLabels(["question"]);
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining(Object.keys(fromPath(root).labels).join(", ")),
    );
  });

  it("does not warn if a rendered changelog label is also present", async () => {
    const { core } = await checkLabels(["question", "bug"]);
    expect(core.warning).not.toHaveBeenCalled();
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it("fails for no label or a label absent from the repository", async () => {
    for (const labels of [[], ["not-in-the-catalog"]]) {
      const { core } = await checkLabels(labels);
      expect(core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining("at least one repository label"),
      );
    }
  });

  it("exempts bot authors without fetching the label catalog", async () => {
    const { core, paginate } = await checkLabels([], "Bot");
    expect(paginate).not.toHaveBeenCalled();
    expect(core.info).toHaveBeenCalledWith(
      expect.stringContaining("Skipping the changelog label check"),
    );
    expect(core.setFailed).not.toHaveBeenCalled();
  });
});

describe("release policy", () => {
  it("records the actual branch protection and label workflow limits", () => {
    for (const text of [
      "test (22.12.0)",
      "test (24)",
      "labels",
      "Admins can bypass",
      "No approving review is required",
      ".github/workflows/pr-label.yml",
      "Bot authors are exempt",
      "question",
      "will not appear in the changelog",
    ]) {
      expect(release).toContain(text);
    }
    expect(release).not.toContain("before merge");
  });

  it("uses explicit increments for breaking 0.x releases", () => {
    expect(release).toContain("npm run release -- minor");
    expect(release).toContain("0.12.0");
  });

  it("distinguishes correctness fixes from host-format migrations", () => {
    expect(release).toContain("Correctness fixes can ship in a patch release");
    expect(release).toContain("new opt-in `format` value in a minor release");
    expect(release).toContain("default changes only in a major release");
    expect(release).toContain("field order");
  });

  it("lists evidence for every target without inventing client versions", () => {
    expect(release).toContain("Verified against host versions");
    expect(release).toContain("client version was not recorded");
    expect(release).toContain("Agent Plugins 1.0.0");
    for (const target of [
      "claude",
      "cursor",
      "copilot",
      "antigravity",
      "codex",
      "agent-plugins",
    ]) {
      expect(release).toMatch(new RegExp(`\\| \\x60${target}\\x60\\s+\\|`));
    }
  });
});
