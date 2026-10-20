import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { walkFiles } from "../src/fs.js";
import { parseMatter } from "../src/targets/validation-shared.js";

let root: string | undefined;

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = undefined;
  }
});

describe("walkFiles", () => {
  it("lists files and dotfiles, follows symlinks, and skips loops and broken links", async () => {
    root = await mkdtemp(path.join(tmpdir(), "pluginpack-walk-"));
    const dir = path.join(root, "tree");
    await mkdir(path.join(dir, "sub", ".hidden"), { recursive: true });
    await mkdir(path.join(root, "elsewhere"), { recursive: true });
    await writeFile(path.join(dir, "a.md"), "a");
    await writeFile(path.join(dir, ".dotfile"), "d");
    await writeFile(path.join(dir, "sub", ".hidden", "b.md"), "b");
    await writeFile(path.join(root, "elsewhere", "c.md"), "c");
    await symlink(path.join(dir, "a.md"), path.join(dir, "file-link.md"));
    await symlink(path.join(root, "elsewhere"), path.join(dir, "dir-link"));
    await symlink(dir, path.join(dir, "sub", "loop"));
    await symlink(path.join(root, "missing"), path.join(dir, "broken"));

    const files = await walkFiles(dir);

    expect(files.map((file) => path.relative(dir, file))).toEqual([
      ".dotfile",
      "a.md",
      path.join("dir-link", "c.md"),
      "file-link.md",
      path.join("sub", ".hidden", "b.md"),
    ]);
    expect(files.every((file) => path.isAbsolute(file))).toBe(true);
  });

  it("returns no files for a missing directory", async () => {
    root = await mkdtemp(path.join(tmpdir(), "pluginpack-walk-"));
    await expect(walkFiles(path.join(root, "nope"))).resolves.toEqual([]);
  });
});

describe("parseMatter", () => {
  it("parses YAML frontmatter and returns the body", () => {
    expect(
      parseMatter("---\nname: demo\ndescription: A demo.\n---\n\n# Body\n"),
    ).toEqual({
      data: { name: "demo", description: "A demo." },
      content: "\n# Body\n",
    });
  });

  it("accepts a BOM, CRLF line endings, and an explicit yaml language", () => {
    expect(
      parseMatter("\uFEFF---yaml\r\nname: demo\r\n---\r\nbody").data,
    ).toEqual({ name: "demo" });
  });

  it("returns empty data with no frontmatter, comment-only frontmatter, or a longer dash line", () => {
    expect(parseMatter("# Just markdown\n").data).toEqual({});
    expect(parseMatter("---\n# only a comment\n---\nbody").data).toEqual({});
    expect(parseMatter("----\nname: x\n----\n").data).toEqual({});
  });

  it("reads to end of file when the closing delimiter is missing", () => {
    expect(parseMatter("---\nname: demo\n")).toEqual({
      data: { name: "demo" },
      content: "",
    });
  });

  it("refuses non-YAML languages without evaluating them", () => {
    const flag = "__pluginpackParseMatterEval";
    expect(() =>
      parseMatter(`---js\n{ name: (globalThis.${flag} = "x") }\n---\n`),
    ).toThrow("JavaScript frontmatter is not supported; use YAML frontmatter.");
    expect((globalThis as Record<string, unknown>)[flag]).toBeUndefined();
    expect(() => parseMatter('---json\n{"name": "x"}\n---\n')).toThrow(
      'Frontmatter language "json" is not supported; use YAML frontmatter.',
    );
  });

  it("rejects frontmatter that isn't a mapping, and invalid YAML", () => {
    expect(() => parseMatter("---\njust a string\n---\n")).toThrow(
      "Frontmatter must be a YAML mapping of fields.",
    );
    expect(() => parseMatter("---\nname: [unclosed\n---\n")).toThrow();
  });
});
