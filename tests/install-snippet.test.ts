import { describe, expect, it } from "vitest";
import {
  buildInstallSnippet,
  getInstallSnippetCitation,
  getSupportedInstallTargets,
  getUnsupportedInstallTargets,
} from "../src/install-snippet.js";
import type { InstallParams } from "../src/install-snippet.js";
import { getMcpDialectCitations, MCP_DIALECTS } from "../src/mcp.js";

const params: InstallParams = {
  repository: "https://github.com/gleanwork/plugins",
  marketplaceName: "glean-plugins",
  pluginName: "glean",
  pluginPath: "plugins/glean",
};

describe("install snippet", () => {
  it("builds the documented claude shell sequence and retains the interactive slash form", () => {
    const snippet = buildInstallSnippet("claude", params);
    expect(snippet).toMatchObject({
      userConfigurable: true,
      kind: "command",
      snippet:
        "claude plugin marketplace add https://github.com/gleanwork/plugins\nclaude plugin install glean@glean-plugins",
    });
    expect(snippet.userConfigurable && snippet.note).toContain(
      "/plugin marketplace add https://github.com/gleanwork/plugins",
    );
    expect(snippet.userConfigurable && snippet.note).toContain(
      "/plugin install glean@glean-plugins",
    );
    expect(snippet.userConfigurable && snippet.note).toContain(
      "opens the plugin details",
    );
    expect(snippet.userConfigurable && snippet.note).not.toContain(
      "slash-only",
    );
  });

  it("builds the exact codex marketplace-add command", () => {
    const snippet = buildInstallSnippet("codex", params);
    expect(snippet).toMatchObject({
      userConfigurable: true,
      kind: "command",
      snippet:
        "codex plugin marketplace add https://github.com/gleanwork/plugins",
    });
  });

  it("builds the exact copilot marketplace-add + install sequence", () => {
    const snippet = buildInstallSnippet("copilot", params);
    expect(snippet).toMatchObject({
      userConfigurable: true,
      kind: "command",
      snippet:
        "copilot plugin marketplace add https://github.com/gleanwork/plugins\ncopilot plugin install glean@glean-plugins",
    });
  });

  it("builds the documented antigravity GitHub URL command with a local subdirectory fallback", () => {
    const snippet = buildInstallSnippet("antigravity", params);
    expect(snippet).toMatchObject({
      userConfigurable: true,
      kind: "command",
      snippet: "agy plugin install https://github.com/gleanwork/plugins",
    });
    expect(snippet.userConfigurable && snippet.note).toContain(
      "do not specify a subdirectory selector",
    );
    expect(snippet.userConfigurable && snippet.note).toContain(
      "git clone https://github.com/gleanwork/plugins plugin-source && cd plugin-source && agy plugin install plugins/glean",
    );
    const citation = getInstallSnippetCitation("antigravity");
    expect(citation.claim).toContain(
      "agy plugin install https://github.com/<owner>/<repo>",
    );
    expect(citation.documentationUrl).toBe(
      "https://antigravity.google/docs/plugins?tab=cli",
    );
  });

  it("builds a repo URL for cursor, with a GUI-paste note (no CLI marketplace-add exists)", () => {
    const snippet = buildInstallSnippet("cursor", params);
    expect(snippet).toMatchObject({
      userConfigurable: true,
      kind: "url",
      snippet: "https://github.com/gleanwork/plugins",
    });
    expect(snippet.userConfigurable && snippet.note).toContain(
      "Import from Repo",
    );
  });

  it("every marketplace target is user-configurable; agent-plugins has no install surface", () => {
    expect(getSupportedInstallTargets().sort()).toEqual(
      ["antigravity", "claude", "codex", "copilot", "cursor"].sort(),
    );
    expect(getUnsupportedInstallTargets()).toEqual(["agent-plugins"]);
    expect(buildInstallSnippet("agent-plugins", params)).toMatchObject({
      userConfigurable: false,
      reason: expect.stringContaining("defines no marketplace"),
    });
  });

  it("every target and every MCP dialect rule carries a dated documentation citation", () => {
    const citations = [
      ...getSupportedInstallTargets(),
      ...getUnsupportedInstallTargets(),
    ].map((target) => getInstallSnippetCitation(target));
    for (const dialect of MCP_DIALECTS) {
      const dialectCitations = getMcpDialectCitations(dialect);
      // verbatim is, by definition, the dialect with nothing documented.
      if (dialect === "verbatim") {
        expect(dialectCitations).toEqual([]);
        continue;
      }
      expect(dialectCitations.length, dialect).toBeGreaterThan(0);
      citations.push(...dialectCitations);
    }
    // Each native dialect cites its root-variable, data-variable, and
    // transport-label rules separately; claude also cites why it rejects
    // "cwd".
    for (const dialect of ["cursor", "copilot"] as const) {
      expect(getMcpDialectCitations(dialect), dialect).toHaveLength(3);
    }
    expect(getMcpDialectCitations("claude")).toHaveLength(4);
    expect(getMcpDialectCitations("claude")).toContainEqual(
      expect.objectContaining({
        claim: expect.stringContaining('"cwd" is not a documented field'),
      }),
    );
    for (const citation of citations) {
      expect(citation.claim).not.toBe("");
      expect(citation.documentationUrl).toMatch(/^https:\/\//);
      expect(citation.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
