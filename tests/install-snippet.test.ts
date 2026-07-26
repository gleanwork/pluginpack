import { describe, expect, it } from "vitest";
import {
  buildInstallSnippet,
  getInstallSnippetCitation,
  getSupportedInstallTargets,
  getUnsupportedInstallTargets,
} from "../src/install-snippet.js";
import type { InstallParams } from "../src/install-snippet.js";

const params: InstallParams = {
  repository: "https://github.com/gleanwork/plugins",
  marketplaceName: "glean-plugins",
  pluginName: "glean",
  pluginPath: "plugins/glean",
};

describe("install snippet", () => {
  it("builds the exact claude slash-command sequence, with the shell alternative as a note", () => {
    const snippet = buildInstallSnippet("claude", params);
    expect(snippet).toMatchObject({
      userConfigurable: true,
      kind: "command",
      snippet:
        "/plugin marketplace add https://github.com/gleanwork/plugins\n/plugin install glean@glean-plugins",
    });
    expect(snippet.userConfigurable && snippet.note).toContain(
      "claude plugin install glean@glean-plugins",
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

  it("builds the exact antigravity clone-and-install sequence, using pluginPath", () => {
    const snippet = buildInstallSnippet("antigravity", params);
    expect(snippet).toMatchObject({
      userConfigurable: true,
      kind: "command",
      snippet:
        "git clone https://github.com/gleanwork/plugins plugin-source && cd plugin-source && agy plugin install plugins/glean",
    });
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

  it("every target is user-configurable today", () => {
    expect(getSupportedInstallTargets().sort()).toEqual(
      ["antigravity", "claude", "codex", "copilot", "cursor"].sort(),
    );
    expect(getUnsupportedInstallTargets()).toEqual([]);
  });

  it("every target carries a dated documentation citation", () => {
    for (const target of getSupportedInstallTargets()) {
      const citation = getInstallSnippetCitation(target);
      expect(citation.documentationUrl).toMatch(/^https:\/\//);
      expect(citation.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("represents the userConfigurable:false shape (no target hits it today, but the type is exercised)", () => {
    const unsupported: ReturnType<typeof buildInstallSnippet> = {
      userConfigurable: false,
      reason: "No CLI or URL install path exists for this target.",
    };
    expect(unsupported.userConfigurable).toBe(false);
  });
});
