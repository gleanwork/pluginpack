import type {
  EmittedPluginConfig,
  FileValue,
  Metadata,
  ResolvedProject,
  TargetConfig,
  TargetName,
  ValidationIssue,
} from "../types.js";

/** Inputs available when building a single plugin's own manifest file. */
export type ManifestBuildContext = {
  metadata: Metadata | undefined;
  version: string;
  pluginName: string;
  pluginConfig: EmittedPluginConfig;
  componentDirs: Set<string>;
  mcpServers: Record<string, unknown> | undefined;
};

/** Inputs available when building a plugin's marketplace entry. */
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

/** Inputs available when building a target's top-level marketplace manifest. */
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

/**
 * A dated pointer to the documentation (or other source) a fact about a
 * target is based on. `claim` describes what the citation backs, not the
 * fact itself.
 */
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

/**
 * Everything that varies by target, in one place. A new target means one new
 * file implementing this interface and one new registry entry, rather than a
 * new branch added independently to component defaults, manifest building,
 * and validation.
 */
export type PluginTargetDefinition = {
  name: TargetName;

  /** Component directories copied into a plugin when it has no `components` override. */
  defaultComponents: readonly string[];

  resolvePluginPath: (
    pluginName: string,
    pluginConfig: EmittedPluginConfig,
    targetConfig: TargetConfig,
  ) => string;

  buildPluginManifest: (ctx: ManifestBuildContext) => Record<string, unknown>;
  /** Output-relative paths the plugin manifest is written to (may be more than one). */
  manifestPaths: (pluginPath: string, targetConfig: TargetConfig) => string[];

  /** Return `undefined` for a target with no marketplace-entry concept. */
  buildMarketplaceEntry: (
    ctx: MarketplaceEntryContext,
  ) => Record<string, unknown> | undefined;
  buildMarketplaceManifest: (
    ctx: MarketplaceManifestContext,
  ) => Record<string, unknown>;
  /** Output-relative paths the marketplace manifest is written to (may be more than one). */
  marketplacePaths: (targetConfig: TargetConfig) => string[];

  /** Return `undefined` for a target with no bundled-MCP-config file convention. */
  mcpConfigPath: (pluginPath: string) => string | undefined;
  hooksPath: (pluginPath: string) => string;

  validateManifest: (
    manifest: Record<string, unknown>,
    pluginName: string,
    issues: ValidationIssue[],
  ) => void;
  /**
   * Validates one marketplace entry. Returns the entry's plugin name if it's
   * well-formed enough to keep validating, or `null` (having already pushed
   * an issue) otherwise.
   */
  validateMarketplaceEntry: (
    entry: Record<string, unknown>,
    index: number,
    root: string,
    issues: ValidationIssue[],
  ) => string | null;
  validateOutput: (root: string, issues: ValidationIssue[]) => Promise<void>;

  installSnippet: InstallSnippetDefinition;

  /** Facts about this target not already carried by a more specific citation above. */
  citations: Citation[];
};
