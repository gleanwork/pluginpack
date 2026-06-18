import path from "node:path";
import { json, toPosix } from "../fs.js";
import { artifact, deepMerge, emitPlugins, stripUndefined } from "./engine.js";
import type {
  Artifact,
  ResolvedProject,
  TargetConfig,
  TargetName,
} from "../types.js";

export async function emitCopilot(
  project: ResolvedProject,
  target: TargetName,
  targetConfig: TargetConfig,
  outDir: string,
): Promise<Artifact> {
  const version = targetConfig.version ?? project.config.version;
  const pluginRoot = targetConfig.pluginRoot ?? "plugins";
  const files = new Map<string, string | Buffer>();

  // Copilot has no per-plugin manifest; each plugin's data lives in its
  // marketplace entry (with a derived skills list), so this omits pluginManifest
  // and builds the entry directly.
  const plugins = await emitPlugins(project, target, targetConfig, files, {
    resolvePluginPath: (pluginName, pluginConfig) =>
      pluginConfig.path ?? toPosix(path.join(pluginRoot, pluginName)),
    buildEntry: ({
      pluginName,
      pluginPath,
      pluginConfig,
      metadata,
      mcpServers,
      pluginFiles,
    }) =>
      stripUndefined({
        name: pluginName,
        source: `./${pluginPath}`,
        description: pluginConfig.description ?? metadata?.description,
        version: pluginConfig.version ?? version,
        skills: [
          ...new Set(
            [...pluginFiles.keys()]
              .filter((file) => file.startsWith("skills/"))
              .map((file) => `./skills/${file.split("/")[1]}`),
          ),
        ].sort(),
        mcpServers: mcpServers ? ".mcp.json" : undefined,
      }),
    mcp: "file",
  });

  const marketplace = stripUndefined(
    deepMerge(
      {
        name: project.config.name,
        metadata: stripUndefined({
          description: project.config.metadata?.description,
          version,
          keywords: project.config.metadata?.keywords,
        }),
        owner:
          project.config.metadata?.owner ?? project.config.metadata?.author,
        plugins,
      },
      targetConfig.manifest ?? {},
    ),
  );
  // Copilot reuses the Claude marketplace schema and reads it from both the
  // repo-root .claude-plugin/ and .github/plugin/ (see github/copilot-plugins).
  const marketplaceJson = json(marketplace);
  files.set(
    toPosix(path.join(".claude-plugin", "marketplace.json")),
    marketplaceJson,
  );
  files.set(
    toPosix(path.join(".github", "plugin", "marketplace.json")),
    marketplaceJson,
  );

  return artifact(target, outDir, files);
}
