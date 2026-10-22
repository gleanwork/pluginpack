import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
) as {
  overrides?: Record<string, string>;
  "release-it": {
    git: { requireBranch?: string };
    github: { tokenRef: string };
  };
};
const release = readFileSync(path.join(root, "RELEASE.md"), "utf8");

describe("release configuration", () => {
  it("uses the documented token variable for the GitHub release", () => {
    expect(pkg["release-it"].github.tokenRef).toBe("GITHUB_AUTH");
    expect(release).toContain("GITHUB_AUTH");
    expect(release).not.toContain("GITHUB_TOKEN");
  });

  it("requires releases from main", () => {
    expect(pkg["release-it"].git.requireBranch).toBe("main");
  });

  it("does not override dev-only dependency versions", () => {
    expect(pkg.overrides).toBeUndefined();
  });
});
