# pluginpack

pluginpack compiles one authored source of agent plugins into the plugin
layouts and catalogs each AI client expects.

## Language

### Authoring

**Source**:
A directory holding one plugin's shared, client-neutral content.
_Avoid_: shared plugin, source plugin (that term names the legacy 0.10 discovered-plugin model)

**Overrides**:
A per-target directory applied after a source, adding or replacing files for one target.
_Avoid_: target overlay, targets/ replacements

**Content kind**:
A selectable category of source content: a component directory, `static`, or `mcp`.
_Avoid_: component (when `static` or `mcp` is meant)

### Output

**Target**:
One output configuration that pluginpack builds, named for the client or format it serves.
_Avoid_: host, adapter (in config), platform

**Package**:
One plugin directory laid out to the Agent Plugins specification: `plugin.json`, `skills/`, `mcp.json`, and any extension directories.
_Avoid_: portable plugin, AP plugin

**Client profile**:
A client's additions to a package: its extension namespace, the manifest data under it, and the files in its extension directory.
_Avoid_: overlay, flavor

**Extension namespace**:
The reverse-domain key a client owns inside a package, such as `com.openai`.
_Avoid_: vendor key, client key

**Marketplace**:
A client's catalog file listing installable plugins, such as `.agents/plugins/marketplace.json`. Not part of a package.
_Avoid_: registry, index, catalog (as a term)

**MCP dialect**:
The plugin-root and plugin-data variable names and transport labels one client's MCP config expects.
_Avoid_: MCP format, MCP flavor

**Artifact**:
The in-memory map of every file one target build emits, plus which paths pluginpack manages.
_Avoid_: output bundle
