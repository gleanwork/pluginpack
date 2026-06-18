import { z } from "zod";
import { isSafeRelativePath } from "./fs.js";

// Paths that get written to / read from disk relative to a root — reject
// absolute paths and ".." escapes so a config can't write or read outside.
const safeRelativePath = z
  .string()
  .refine(
    isSafeRelativePath,
    'must be a safe relative path (no absolute paths or ".." segments)',
  );

const authorSchema = z.object({
  name: z.string().min(1),
  email: z.string().optional(),
  url: z.string().optional(),
});

const metadataSchema = z.object({
  displayName: z.string().optional(),
  description: z.string().optional(),
  author: authorSchema.optional(),
  owner: authorSchema.optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  logo: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  category: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const rootPluginSchema = metadataSchema.extend({
  id: z.string().min(1).optional(),
  name: z.string().optional(),
  description: z.string().optional(),
});

const sourceSchema = z.object({
  plugins: z.string().optional(),
  skills: z.string().optional(),
  rootPlugin: rootPluginSchema.optional(),
});

const emittedPluginSchema = z.object({
  from: z.array(z.string().min(1)).min(1),
  path: safeRelativePath.optional(),
  version: z.string().optional(),
  description: z.string().optional(),
  displayName: z.string().optional(),
  manifest: z.record(z.string(), z.unknown()).optional(),
  // Deep-merged into this plugin's generated marketplace entry (the object in
  // the marketplace `plugins` array), letting a config supply target-specific
  // entry fields a target can't derive — e.g. Codex `policy`/`category`.
  entry: z.record(z.string(), z.unknown()).optional(),
  components: z.array(z.string()).optional(),
});

const targetSchema = z.object({
  outDir: z.string().min(1),
  marketplaceDir: safeRelativePath.optional(),
  pluginRoot: safeRelativePath.optional(),
  version: z.string().optional(),
  plugins: z.record(z.string(), emittedPluginSchema),
  manifest: z.record(z.string(), z.unknown()).optional(),
  ignoredDiffPaths: z.array(z.string()).optional(),
  // Files emitted verbatim at the output repo root (relative to outDir), keyed
  // by output path → source path (relative to the config root). Managed like
  // any other emitted file, so a repo-root README/LICENSE is authored once in
  // the source repo and synced to every target instead of hand-maintained.
  rootFiles: z.record(safeRelativePath, safeRelativePath).optional(),
});

const configSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  source: sourceSchema.optional(),
  metadata: metadataSchema.optional(),
  targets: z.object({
    claude: targetSchema.optional(),
    copilot: targetSchema.optional(),
    cursor: targetSchema.optional(),
    antigravity: targetSchema.optional(),
    codex: targetSchema.optional(),
  }),
});

const sourcePluginManifestSchema = metadataSchema.extend({
  name: z.string().optional(),
  description: z.string().optional(),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
});

export { configSchema, sourcePluginManifestSchema };

export type Author = z.infer<typeof authorSchema>;
export type Metadata = z.infer<typeof metadataSchema>;
export type SourceConfig = z.infer<typeof sourceSchema>;
export type EmittedPluginConfig = z.infer<typeof emittedPluginSchema>;
export type TargetConfig = z.infer<typeof targetSchema>;
export type PluginpackConfig = z.infer<typeof configSchema>;
export type SourcePluginManifest = z.infer<typeof sourcePluginManifestSchema>;
