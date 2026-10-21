import path from "node:path";
import { isSafeRelativePath } from "./fs.js";
import type { Citation } from "./targets/types.js";

/**
 * MCP configuration rendering.
 *
 * Authored MCP config (`mcp/config.json`, or a legacy `.mcp.json`) may be
 * written in either of two shapes:
 *
 * - the Agent Plugins 1.0 form — an explicit `type` per server and the
 *   standard `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` placeholders;
 * - the Claude-style form most plugins started from — `type` optional
 *   (`command` implies stdio), `${CLAUDE_PLUGIN_ROOT}` or
 *   `${CURSOR_PLUGIN_ROOT}` placeholders.
 *
 * Each client reads a different MCP dialect: its own plugin-root and
 * plugin-data variable names and its own transport labels. This module owns
 * every dialect, so a target only names the dialect it emits — no target
 * rewrites MCP config itself, and no author has to fork `config.json` per
 * target just to change a variable name.
 */

/**
 * - `agent-plugins` — the portable Agent Plugins 1.0 `mcp.json`: `$schema`,
 *   an explicit `type` per server, and full validation against the spec,
 *   because a non-conforming server is silently skipped by clients.
 * - `codex` — the Agent Plugins dialect plus the per-server
 *   `extensions["com.openai"]` object Codex reads MCP auth from. The spec's
 *   closed server shape has no such field, so only Codex-only output may
 *   carry it (see CONFORMANCE.md, "MCP dialect facts").
 * - `claude`, `cursor`, `copilot` — the client's native dialect.
 * - `verbatim` — emitted exactly as authored, for a client whose dialect
 *   isn't documented.
 */
export const MCP_DIALECTS = [
  "agent-plugins",
  "codex",
  "claude",
  "cursor",
  "copilot",
  "verbatim",
] as const;

export type McpDialect = (typeof MCP_DIALECTS)[number];

export const AGENT_PLUGINS_MCP_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

const AGENT_PLUGINS_SPEC_CITATION: Citation = {
  claim:
    'mcp.json is closed: each server declares "type" and matches exactly one variant, and an unknown field makes the entry invalid; "command" is one bare or ./ executable token with no placeholder expansion; "args", "env", and "cwd" expand ${PLUGIN_ROOT} and ${PLUGIN_DATA}',
  documentationUrl: "https://agent-plugins.org/specification",
  verifiedAt: "2026-10-21",
};

/** The namespace Codex reads per-server MCP settings from. */
const CODEX_SERVER_NAMESPACE = "com.openai";

/**
 * The documentation each dialect's rules are based on. `verbatim` has none:
 * it exists for clients whose dialect isn't documented.
 */
export function getMcpDialectCitations(dialect: McpDialect): Citation[] {
  switch (dialect) {
    case "agent-plugins":
      return [AGENT_PLUGINS_SPEC_CITATION];
    case "codex":
      return [
        AGENT_PLUGINS_SPEC_CITATION,
        {
          claim:
            'Codex reads per-server MCP authentication from extensions["com.openai"].auth on each server in mcp.json, not from plugin.json',
          documentationUrl: "https://developers.openai.com/codex/plugins/build",
          verifiedAt: "2026-10-21",
        },
      ];
    case "verbatim":
      return [];
    default: {
      const { citations, ignoresCwd } = nativeDialects[dialect];
      return [...Object.values(citations), ...(ignoresCwd ? [ignoresCwd] : [])];
    }
  }
}

/**
 * Renders authored MCP servers into one dialect's complete config file
 * object (ready for `json()`). `context` prefixes error messages, e.g.
 * `Target "codex" plugin "acme"`. Throws when the config can't be expressed
 * in the dialect — a server the client would silently skip is a build error.
 */
export function renderMcpConfig(
  servers: Record<string, unknown>,
  dialect: McpDialect,
  context: string,
): Record<string, unknown> {
  if (dialect === "verbatim") {
    return { mcpServers: servers };
  }
  if (dialect === "agent-plugins" || dialect === "codex") {
    const mcpServers: Record<string, unknown> = {};
    for (const [name, server] of Object.entries(servers)) {
      mcpServers[name] = toAgentPluginsServer(
        server,
        `${context}: MCP server "${name}"`,
        dialect === "codex",
      );
    }
    return { $schema: AGENT_PLUGINS_MCP_SCHEMA, mcpServers };
  }
  const rules = nativeDialects[dialect];
  const mcpServers: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    mcpServers[name] = toNativeServer(
      server,
      dialect,
      rules,
      `${context}: MCP server "${name}"`,
    );
  }
  return { mcpServers };
}

/**
 * The plugin file each server's `command` names, for commands written as a
 * `./` path or rooted at a plugin-root variable. `file` is relative to the
 * plugin root. Commands that aren't a plain path inside the plugin (a bare
 * name, a data-variable path, an escape) are left to `renderMcpConfig`.
 */
export function pluginCommandFiles(
  servers: Record<string, unknown>,
): { server: string; command: string; file: string }[] {
  const result: { server: string; command: string; file: string }[] = [];
  for (const [server, config] of Object.entries(servers)) {
    const command = isObject(config) ? config.command : undefined;
    if (typeof command !== "string") {
      continue;
    }
    const prefix = ["./", ...ROOT_VARIABLES.map((name) => `\${${name}}/`)].find(
      (candidate) => command.startsWith(candidate),
    );
    const rest = prefix === undefined ? "" : command.slice(prefix.length);
    if (!rest || /\s|\$\{/.test(rest) || !isSafeRelativePath(rest)) {
      continue;
    }
    result.push({ server, command, file: path.posix.normalize(rest) });
  }
  return result;
}

const ROOT_VARIABLES = [
  "PLUGIN_ROOT",
  "CLAUDE_PLUGIN_ROOT",
  "CURSOR_PLUGIN_ROOT",
];
const DATA_VARIABLES = ["PLUGIN_DATA", "CLAUDE_PLUGIN_DATA"];

/**
 * How a native dialect treats one family of variables (plugin root or
 * plugin data): `native` names are left untouched, any other known name is
 * rewritten to `canonical`. `unsupported` makes any use a build error;
 * `passthrough` leaves every name as authored because the client's support
 * isn't documented.
 */
type VariableRule =
  { canonical: string; native: string[] } | "unsupported" | "passthrough";

type NativeDialectRules = {
  client: string;
  root: { canonical: string; native: string[] };
  data: VariableRule;
  /**
   * Authored transport label → emitted label; `null` drops the field (the
   * client infers the transport from `command`/`url`). Labels not listed
   * pass through unchanged, and a server without a `type` never gains one.
   */
  types: Record<string, string | null>;
  /** The documentation behind each of the three rules above. */
  citations: Record<"root" | "data" | "types", Citation>;
  /**
   * Set when the client ignores a stdio server's `cwd`, with the
   * documentation behind it: a server with `cwd` is then a build error,
   * because the server would start in the wrong directory. Unset, `cwd` is
   * kept, with a `./` path spelled out from the plugin root.
   */
  ignoresCwd?: Citation;
};

const CLAUDE_PLUGINS_REFERENCE =
  "https://code.claude.com/docs/en/plugins-reference#environment-variables";
const CURSOR_PLUGINS_REFERENCE =
  "https://cursor.com/docs/reference/plugins#mcp-servers";
const COPILOT_PLUGINS_REFERENCE =
  "https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference";

const nativeDialects: Record<
  Exclude<McpDialect, "agent-plugins" | "codex" | "verbatim">,
  NativeDialectRules
> = {
  claude: {
    client: "Claude Code",
    root: { canonical: "CLAUDE_PLUGIN_ROOT", native: ["CLAUDE_PLUGIN_ROOT"] },
    data: { canonical: "CLAUDE_PLUGIN_DATA", native: ["CLAUDE_PLUGIN_DATA"] },
    types: { "streamable-http": "http" },
    citations: {
      root: {
        claim:
          "Claude Code expands ${CLAUDE_PLUGIN_ROOT} to the plugin's installed path in an MCP stdio server's command, args, and env",
        documentationUrl: CLAUDE_PLUGINS_REFERENCE,
        verifiedAt: "2026-10-21",
      },
      data: {
        claim:
          "Claude Code expands ${CLAUDE_PLUGIN_DATA} to a persistent per-plugin directory in the same fields",
        documentationUrl: CLAUDE_PLUGINS_REFERENCE,
        verifiedAt: "2026-10-21",
      },
      types: {
        claim:
          'an entry with no "type" is a stdio server; Streamable HTTP is "http", with "streamable-http" accepted as an alias',
        documentationUrl: "https://code.claude.com/docs/en/mcp",
        verifiedAt: "2026-10-21",
      },
    },
    ignoresCwd: {
      claim:
        'Claude Code resolves ${...} in a plugin MCP stdio server\'s command, args, and env only; "cwd" is not a documented field, and Claude Code 2.1.284 starts the server in the session\'s working directory whatever "cwd" says',
      documentationUrl: CLAUDE_PLUGINS_REFERENCE,
      verifiedAt: "2026-10-21",
    },
  },
  cursor: {
    client: "Cursor",
    root: {
      canonical: "CURSOR_PLUGIN_ROOT",
      native: ["CURSOR_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"],
    },
    data: "unsupported",
    types: { stdio: null, http: null, "streamable-http": null },
    citations: {
      root: {
        claim:
          "Cursor expands ${CURSOR_PLUGIN_ROOT} and ${CLAUDE_PLUGIN_ROOT} in command, args, env values, and cwd, and does not expand the standard ${PLUGIN_ROOT}",
        documentationUrl: CURSOR_PLUGINS_REFERENCE,
        verifiedAt: "2026-10-21",
      },
      data: {
        claim:
          "Cursor does not expand ${PLUGIN_DATA} and documents no plugin-data variable of its own",
        documentationUrl: CURSOR_PLUGINS_REFERENCE,
        verifiedAt: "2026-10-21",
      },
      types: {
        claim:
          "Cursor plugins can infer the transport from command or url instead of declaring it",
        documentationUrl: CURSOR_PLUGINS_REFERENCE,
        verifiedAt: "2026-10-21",
      },
    },
  },
  copilot: {
    client: "Copilot",
    root: {
      canonical: "PLUGIN_ROOT",
      native: ["PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"],
    },
    data: "passthrough",
    types: { "streamable-http": "http" },
    citations: {
      root: {
        claim:
          "Copilot CLI names the plugin root ${PLUGIN_ROOT}, with ${CLAUDE_PLUGIN_ROOT} as an alias (documented for plugin agents' MCP servers and LSP config; the legacy .mcp.json format has no separate list)",
        documentationUrl: COPILOT_PLUGINS_REFERENCE,
        verifiedAt: "2026-10-21",
      },
      data: {
        claim:
          "${PLUGIN_DATA} (aliases ${COPILOT_PLUGIN_DATA}, ${CLAUDE_PLUGIN_DATA}) is documented only for Agent Plugins 1.0 MCP servers, so legacy-format config keeps data variables as authored",
        documentationUrl: COPILOT_PLUGINS_REFERENCE,
        verifiedAt: "2026-10-21",
      },
      types: {
        claim:
          'Copilot CLI reads remote servers labelled "http", "sse", or "streamable-http"',
        documentationUrl: COPILOT_PLUGINS_REFERENCE,
        verifiedAt: "2026-10-21",
      },
    },
  },
};

function toNativeServer(
  server: unknown,
  dialect: string,
  rules: NativeDialectRules,
  context: string,
): unknown {
  if (!isObject(server)) {
    return server;
  }
  if (rules.ignoresCwd && server.cwd !== undefined) {
    throw new Error(
      `${context} has "cwd", but ${rules.client} ignores "cwd" for plugin MCP servers and starts them in the user's working directory. Remove "cwd" and resolve paths in "args" with \${${rules.root.canonical}} instead (for example "args": ["\${${rules.root.canonical}}/server/index.js"]), or put a ${dialect}-only config.json without "cwd" in the ${dialect} plugin's overrides directory (mcp/config.json).`,
    );
  }
  const rewrite = (value: string) => rewriteNative(value, rules, context);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(server)) {
    if (key === "type" && typeof value === "string" && value in rules.types) {
      const label = rules.types[value];
      if (label !== null) {
        result.type = label;
      }
      continue;
    }
    if (key === "command" && typeof value === "string") {
      // An Agent Plugins plugin-relative command (`./bin/server`) resolves
      // against the plugin root; native clients need the root spelled out.
      result.command = value.startsWith("./")
        ? `\${${rules.root.canonical}}/${value.slice(2)}`
        : rewrite(value);
      continue;
    }
    if (key === "cwd" && typeof value === "string" && value.startsWith("./")) {
      // A plugin-relative cwd too: native clients resolve a relative cwd
      // against their own working directory, not the plugin.
      const rest = value.slice(2);
      result.cwd = rest
        ? `\${${rules.root.canonical}}/${rest}`
        : `\${${rules.root.canonical}}`;
      continue;
    }
    result[key] = rewriteField(key, value, rewrite);
  }
  return result;
}

function rewriteNative(
  value: string,
  rules: NativeDialectRules,
  context: string,
): string {
  let result = rewriteVariables(value, ROOT_VARIABLES, rules.root);
  if (rules.data === "unsupported") {
    const used = DATA_VARIABLES.find((name) => value.includes(`\${${name}}`));
    if (used) {
      throw new Error(
        `${context} uses \${${used}}, but ${rules.client} has no plugin-data variable.`,
      );
    }
  } else if (rules.data !== "passthrough") {
    result = rewriteVariables(result, DATA_VARIABLES, rules.data);
  }
  return result;
}

function rewriteVariables(
  value: string,
  family: string[],
  rule: { canonical: string; native: string[] },
): string {
  let result = value;
  for (const name of family) {
    if (!rule.native.includes(name)) {
      result = result.replaceAll(`\${${name}}`, `\${${rule.canonical}}`);
    }
  }
  return result;
}

/** Applies `rewrite` to the server fields where clients expand plugin variables. */
function rewriteField(
  key: string,
  value: unknown,
  rewrite: (value: string) => string,
): unknown {
  if (key === "cwd" && typeof value === "string") {
    return rewrite(value);
  }
  if (key === "args" && Array.isArray(value)) {
    return value.map((arg) => (typeof arg === "string" ? rewrite(arg) : arg));
  }
  if (key === "env" && isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, envValue]) => [
        name,
        typeof envValue === "string" ? rewrite(envValue) : envValue,
      ]),
    );
  }
  return value;
}

type AgentPluginsTransport = "stdio" | "streamable-http" | "sse";

/** Authored transport labels the Agent Plugins dialect understands. */
const agentPluginsTypes: Record<string, AgentPluginsTransport> = {
  stdio: "stdio",
  "streamable-http": "streamable-http",
  http: "streamable-http",
  sse: "sse",
};

const STDIO_FIELDS = new Set(["type", "command", "args", "env", "cwd"]);
const REMOTE_FIELDS = new Set(["type", "url", "headers"]);

/**
 * Converts one authored server to the Agent Plugins 1.0 shape and enforces
 * spec §7.2.1 and §9 — each violation would make a conforming client skip
 * the server, so it fails the build here instead. With `codexExtensions`,
 * the server may also carry Codex's `extensions["com.openai"]` object.
 */
function toAgentPluginsServer(
  server: unknown,
  context: string,
  codexExtensions: boolean,
): Record<string, unknown> {
  if (!isObject(server)) {
    throw new Error(`${context} must be an object.`);
  }
  const type = agentPluginsTransport(server, context);
  const allowed = type === "stdio" ? STDIO_FIELDS : REMOTE_FIELDS;
  for (const key of Object.keys(server)) {
    if (key === "extensions" && codexExtensions) {
      continue;
    }
    if (!allowed.has(key)) {
      const hint =
        key === "extensions"
          ? ` Only the codex target emits per-server "extensions" (Codex reads MCP auth from extensions["${CODEX_SERVER_NAMESPACE}"].auth); other Agent Plugins clients skip a server that has them. Remove it here, and put a copy of config.json with it in the codex plugin's overrides directory (mcp/config.json).`
          : "";
      throw new Error(
        `${context} has field "${key}", which the Agent Plugins ${type} server shape does not allow (allowed: ${[...allowed].join(", ")}).${hint}`,
      );
    }
  }
  const result =
    type === "stdio"
      ? toAgentPluginsStdio(server, context)
      : toAgentPluginsRemote(type, server, context);
  if (codexExtensions && server.extensions !== undefined) {
    result.extensions = codexServerExtensions(server.extensions, context);
  }
  return result;
}

/**
 * Codex documents only `extensions["com.openai"]` on an MCP server; any
 * other namespace means nothing in Codex-only output, so it is an error.
 */
function codexServerExtensions(
  value: unknown,
  context: string,
): Record<string, unknown> {
  if (!isObject(value)) {
    throw new Error(
      `${context} "extensions" must be an object keyed by extension namespace, such as { "${CODEX_SERVER_NAMESPACE}": { "auth": { ... } } }.`,
    );
  }
  for (const [namespace, data] of Object.entries(value)) {
    if (namespace !== CODEX_SERVER_NAMESPACE) {
      throw new Error(
        `${context} has extensions["${namespace}"]; Codex reads only extensions["${CODEX_SERVER_NAMESPACE}"] on an MCP server. Remove it.`,
      );
    }
    if (!isObject(data)) {
      throw new Error(
        `${context} extensions["${CODEX_SERVER_NAMESPACE}"] must be an object.`,
      );
    }
  }
  return value;
}

function agentPluginsTransport(
  server: Record<string, unknown>,
  context: string,
): AgentPluginsTransport {
  if (server.type !== undefined) {
    const type =
      typeof server.type === "string"
        ? agentPluginsTypes[server.type]
        : undefined;
    if (!type) {
      throw new Error(
        `${context} has type ${JSON.stringify(server.type)}; Agent Plugins supports "stdio", "streamable-http", and "sse".`,
      );
    }
    return type;
  }
  if (server.command !== undefined) {
    return "stdio";
  }
  if (server.url !== undefined) {
    return "streamable-http";
  }
  throw new Error(`${context} needs a "command" (stdio) or a "url" (remote).`);
}

function toAgentPluginsStdio(
  server: Record<string, unknown>,
  context: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: "stdio",
    command: agentPluginsCommand(server.command, context),
  };
  if (server.args !== undefined) {
    if (
      !Array.isArray(server.args) ||
      !server.args.every((arg) => typeof arg === "string")
    ) {
      throw new Error(`${context} "args" must be an array of strings.`);
    }
    result.args = server.args.map((arg: string) =>
      agentPluginsExpandable(arg, `${context} "args"`),
    );
  }
  if (server.env !== undefined) {
    result.env = agentPluginsEnv(server.env, context);
  }
  if (server.cwd !== undefined) {
    result.cwd = agentPluginsCwd(server.cwd, context);
  }
  return result;
}

/**
 * `command` is one executable token — a bare name resolved on the client's
 * search path, or a `./` path inside the plugin. No placeholder expansion
 * happens in it, so an authored `${CLAUDE_PLUGIN_ROOT}/bin/x` becomes the
 * equivalent `./bin/x`.
 */
function agentPluginsCommand(value: unknown, context: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${context} "command" must be a non-empty string.`);
  }
  let command = value;
  for (const name of ROOT_VARIABLES) {
    const prefix = `\${${name}}/`;
    if (command.startsWith(prefix)) {
      command = `./${command.slice(prefix.length)}`;
      break;
    }
  }
  if (command.includes("${")) {
    throw new Error(
      `${context} "command" is ${JSON.stringify(value)}; Agent Plugins does not expand placeholders in "command" — use a bare executable name or a ./ path inside the plugin.`,
    );
  }
  if (command.startsWith("./")) {
    // A space means the author wrote a shell string: clients run the whole
    // value as one file name.
    if (/\s/.test(command)) {
      throw new Error(
        `${context} "command" is ${JSON.stringify(value)}; Agent Plugins requires a single executable token and runs the whole value as one file name. Move arguments into "args".`,
      );
    }
    if (!isSafeRelativePath(command.slice(2)) || command === "./") {
      throw new Error(
        `${context} "command" ${JSON.stringify(value)} must stay inside the plugin root.`,
      );
    }
    return command;
  }
  if (/[\s/\\]/.test(command)) {
    throw new Error(
      `${context} "command" is ${JSON.stringify(value)}; Agent Plugins requires a single executable token — a bare name such as "node", or a ./ path inside the plugin. Move arguments into "args".`,
    );
  }
  return command;
}

function agentPluginsEnv(
  value: unknown,
  context: string,
): Record<string, string> {
  if (!isObject(value)) {
    throw new Error(`${context} "env" must be an object of strings.`);
  }
  const result: Record<string, string> = {};
  for (const [name, envValue] of Object.entries(value)) {
    if (typeof envValue !== "string") {
      throw new Error(`${context} "env.${name}" must be a string.`);
    }
    if (["PLUGIN_ROOT", "PLUGIN_DATA"].includes(name.toUpperCase())) {
      throw new Error(
        `${context} "env" sets ${name}, which Agent Plugins reserves for the client.`,
      );
    }
    result[name] = agentPluginsExpandable(envValue, `${context} "env.${name}"`);
  }
  return result;
}

/**
 * `cwd` is a `./` path, or rooted at `${PLUGIN_ROOT}` or `${PLUGIN_DATA}`,
 * and stays inside that root.
 */
function agentPluginsCwd(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new Error(`${context} "cwd" must be a string.`);
  }
  const cwd = agentPluginsExpandable(value, `${context} "cwd"`);
  const rest = ["./", "${PLUGIN_ROOT}/", "${PLUGIN_DATA}/"]
    .filter((prefix) => cwd.startsWith(prefix))
    .map((prefix) => cwd.slice(prefix.length))[0];
  const isRoot = cwd === "${PLUGIN_ROOT}" || cwd === "${PLUGIN_DATA}";
  if (
    !isRoot &&
    (rest === undefined || (rest !== "" && !isSafeRelativePath(rest)))
  ) {
    throw new Error(
      `${context} "cwd" is ${JSON.stringify(value)}; Agent Plugins requires a ./ path or a path under \${PLUGIN_ROOT} or \${PLUGIN_DATA} that stays inside it (omit "cwd" to use the plugin root).`,
    );
  }
  return cwd;
}

/**
 * Normalizes known plugin-root/data variables to the standard names, then
 * rejects any other `${...}` — Agent Plugins leaves it literal, so e.g. an
 * env-var reference that worked in Claude would silently stop working.
 */
function agentPluginsExpandable(value: string, context: string): string {
  let result = rewriteVariables(value, ROOT_VARIABLES, {
    canonical: "PLUGIN_ROOT",
    native: ["PLUGIN_ROOT"],
  });
  result = rewriteVariables(result, DATA_VARIABLES, {
    canonical: "PLUGIN_DATA",
    native: ["PLUGIN_DATA"],
  });
  for (const match of result.matchAll(/\$\{([^}]*)\}/g)) {
    if (match[1] !== "PLUGIN_ROOT" && match[1] !== "PLUGIN_DATA") {
      throw new Error(
        `${context} uses \${${match[1]}}; Agent Plugins expands only \${PLUGIN_ROOT} and \${PLUGIN_DATA} and leaves anything else literal.`,
      );
    }
  }
  return result;
}

function toAgentPluginsRemote(
  type: "streamable-http" | "sse",
  server: Record<string, unknown>,
  context: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type,
    url: agentPluginsUrl(server.url, context),
  };
  if (server.headers !== undefined) {
    result.headers = agentPluginsHeaders(server.headers, context);
  }
  return result;
}

function agentPluginsUrl(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new Error(`${context} "url" must be a string.`);
  }
  if (value.includes("${")) {
    throw new Error(
      `${context} "url" contains a placeholder; Agent Plugins does not expand placeholders in "url".`,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `${context} "url" ${JSON.stringify(value)} is not an absolute URL.`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${context} "url" must use https (or http for loopback).`);
  }
  if (url.username || url.password || url.hash) {
    throw new Error(
      `${context} "url" must not contain user information or a fragment.`,
    );
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new Error(
      `${context} "url" uses http for a non-loopback host; Agent Plugins requires https.`,
    );
  }
  return value;
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

function agentPluginsHeaders(
  value: unknown,
  context: string,
): Record<string, string> {
  if (!isObject(value)) {
    throw new Error(`${context} "headers" must be an object of strings.`);
  }
  const seen = new Set<string>();
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") {
      throw new Error(`${context} header "${name}" must be a string.`);
    }
    if (seen.has(name.toLowerCase())) {
      throw new Error(
        `${context} sets header "${name}" more than once (header names are case-insensitive).`,
      );
    }
    seen.add(name.toLowerCase());
    if (headerValue.includes("${")) {
      throw new Error(
        `${context} header "${name}" contains a placeholder; Agent Plugins does not expand placeholders in headers, and headers must not carry secrets.`,
      );
    }
  }
  return value as Record<string, string>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
