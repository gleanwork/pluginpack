import type {
  EmittedPluginConfig,
  FileValue,
  Metadata,
  ResolvedProject,
  TargetConfig,
  TargetName,
  ValidationIssue,
} from "../types.js";

export type ManifestBuildContext = {
  metadata: Metadata | undefined;
  version: string;
  pluginName: string;
  pluginConfig: EmittedPluginConfig;
  componentDirs: Set<string>;
  mcpServers: Record<string, unknown> | undefined;
};

export type MarketplaceEntryContext = {
  pluginName: string;
  pluginPath: string;
  pluginConfig: EmittedPluginConfig;
  metadata: Metadata | undefined;
  componentDirs: Set<string>;
  mcpServers: Record<string, unknown> | undefined;
  pluginFiles: Map<string, FileValue>;
  manifest: Record<string, unknown> | undefined;
};

export type MarketplaceManifestContext = {
  project: ResolvedProject;
  targetConfig: TargetConfig;
  version: string;
  plugins: Record<string, unknown>[];
};

export type InstallSnippetKind = "command" | "url";

export type InstallParams = {
  repository: string;
  marketplaceName: string;
  pluginName: string;
  pluginPath: string;
};

export type InstallSnippet =
  | {
      userConfigurable: true;
      kind: InstallSnippetKind;
      snippet: string;
      note?: string;
    }
  | { userConfigurable: false; reason: string };

// A fact about a target traces to one of these — the discipline this whole
// registry exists to enforce (see CONFORMANCE.md). `claim` is a short
// human-readable description of what the citation backs, not the fact itself.
export type Citation = {
  claim: string;
  documentationUrl: string;
  verifiedAt: string;
};

export type InstallSnippetDefinition = {
  userConfigurable: boolean;
  build?: (params: InstallParams) => {
    kind: InstallSnippetKind;
    snippet: string;
    note?: string;
  };
  unsupportedReason?: string;
  citation: Citation;
};

// Everything that varies by target, in one place. A new target means one new
// file implementing this interface and one new entry in the registry — not a
// new branch scattered across components.ts/targets.ts/validate.ts, which is
// exactly how the bugs this registry fixes went unnoticed (see CONFORMANCE.md
// "Per-target spec verification").
export type PluginTargetDefinition = {
  name: TargetName;

  // The component dirs copied into an emitted plugin when a plugin config
  // doesn't supply its own `components` override.
  defaultComponents: readonly string[];

  resolvePluginPath: (
    pluginName: string,
    pluginConfig: EmittedPluginConfig,
    targetConfig: TargetConfig,
  ) => string;

  // Every target writes one now (Copilot didn't; that was the biggest Plan 1 fix).
  buildPluginManifest: (ctx: ManifestBuildContext) => Record<string, unknown>;
  // One or more output-relative paths (Copilot mirrors it at both the plugin
  // root and .github/plugin/, matching real published plugins rather than
  // the docs' single-location illustrative tree — see CONFORMANCE.md).
  manifestPaths: (pluginPath: string) => string[];

  // Omit (return undefined) for a target with no marketplace-entry concept —
  // none currently omit it, but the shape allows for one that might.
  buildMarketplaceEntry: (
    ctx: MarketplaceEntryContext,
  ) => Record<string, unknown> | undefined;
  buildMarketplaceManifest: (
    ctx: MarketplaceManifestContext,
  ) => Record<string, unknown>;
  // One or more output-relative paths the marketplace manifest is written to
  // (Copilot mirrors it at two paths).
  marketplacePaths: () => string[];

  // undefined for a target with no bundled-MCP-config file convention.
  mcpConfigPath: (pluginPath: string) => string | undefined;
  hooksPath: (pluginPath: string) => string;

  validateManifest: (
    manifest: Record<string, unknown>,
    pluginName: string,
    issues: ValidationIssue[],
  ) => void;
  // Returns the entry's plugin name if it's well-formed enough to keep
  // validating, or null (having already pushed an issue) if not — mirrors the
  // existing validatePluginEntry contract so per-target output validation can
  // keep sharing its calling convention.
  validateMarketplaceEntry: (
    entry: Record<string, unknown>,
    index: number,
    root: string,
    issues: ValidationIssue[],
  ) => string | null;
  validateOutput: (root: string, issues: ValidationIssue[]) => Promise<void>;

  installSnippet: InstallSnippetDefinition;

  // Facts about this target not already carried by a more specific citation
  // above (e.g. the overall component model, naming pattern).
  citations: Citation[];
};
