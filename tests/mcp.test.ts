import { describe, expect, it } from "vitest";
import {
  AGENT_PLUGINS_MCP_SCHEMA,
  renderMcpConfig,
  type McpDialect,
} from "../src/mcp.js";

const context = 'Target "t" plugin "p"';

function render(servers: Record<string, unknown>, dialect: McpDialect) {
  return renderMcpConfig(servers, dialect, context);
}

// The shape most existing plugins author today (Glean's shared config).
const claudeStyle = {
  local: {
    command: "node",
    args: ["${CLAUDE_PLUGIN_ROOT}/mcp/start.mjs"],
    env: { ENABLE_HITL: "true" },
  },
};

// The same server authored in the Agent Plugins 1.0 form.
const agentPluginsStyle = {
  local: {
    type: "stdio",
    command: "node",
    args: ["${PLUGIN_ROOT}/mcp/start.mjs"],
    env: { ENABLE_HITL: "true" },
  },
};

describe("renderMcpConfig: native dialects", () => {
  it("leaves Claude-style config byte-identical for claude, cursor, and copilot", () => {
    for (const dialect of ["claude", "cursor", "copilot"] as const) {
      expect(JSON.stringify(render(claudeStyle, dialect))).toBe(
        JSON.stringify({ mcpServers: claudeStyle }),
      );
    }
  });

  it("emits verbatim for the verbatim dialect, whatever the shape", () => {
    const odd = { s: { command: "x", type: "ws", whatever: 1 } };
    expect(render(odd, "verbatim")).toEqual({ mcpServers: odd });
  });

  it.each([
    ["claude", "${CLAUDE_PLUGIN_ROOT}/mcp/start.mjs", "stdio"],
    ["copilot", "${PLUGIN_ROOT}/mcp/start.mjs", "stdio"],
  ] as const)(
    "renders Agent Plugins-authored config into the %s dialect",
    (dialect, arg, type) => {
      const servers = render(agentPluginsStyle, dialect).mcpServers as Record<
        string,
        Record<string, unknown>
      >;
      expect(servers.local).toEqual({
        type,
        command: "node",
        args: [arg],
        env: { ENABLE_HITL: "true" },
      });
    },
  );

  it("drops transports Cursor infers and uses ${CURSOR_PLUGIN_ROOT}", () => {
    const servers = render(
      {
        ...agentPluginsStyle,
        remote: { type: "streamable-http", url: "https://example.com/mcp" },
        legacy: { type: "sse", url: "https://example.com/sse" },
      },
      "cursor",
    ).mcpServers;
    expect(servers).toEqual({
      local: {
        command: "node",
        args: ["${CURSOR_PLUGIN_ROOT}/mcp/start.mjs"],
        env: { ENABLE_HITL: "true" },
      },
      remote: { url: "https://example.com/mcp" },
      legacy: { type: "sse", url: "https://example.com/sse" },
    });
  });

  it("labels Streamable HTTP as http for claude and copilot", () => {
    for (const dialect of ["claude", "copilot"] as const) {
      expect(
        render(
          { r: { type: "streamable-http", url: "https://example.com/mcp" } },
          dialect,
        ).mcpServers,
      ).toEqual({ r: { type: "http", url: "https://example.com/mcp" } });
    }
  });

  it("spells out the plugin root for a ./ command", () => {
    const servers = { s: { type: "stdio", command: "./bin/server" } };
    expect(render(servers, "claude").mcpServers).toEqual({
      s: { type: "stdio", command: "${CLAUDE_PLUGIN_ROOT}/bin/server" },
    });
    expect(render(servers, "cursor").mcpServers).toEqual({
      s: { command: "${CURSOR_PLUGIN_ROOT}/bin/server" },
    });
  });

  it("maps plugin-data variables for claude and leaves copilot's alone", () => {
    const servers = {
      s: { command: "node", env: { DATA: "${PLUGIN_DATA}/cache" } },
    };
    expect(render(servers, "claude").mcpServers).toEqual({
      s: { command: "node", env: { DATA: "${CLAUDE_PLUGIN_DATA}/cache" } },
    });
    expect(render(servers, "copilot").mcpServers).toEqual(servers);
  });

  it("fails when Cursor would need a plugin-data variable it doesn't have", () => {
    expect(() =>
      render({ s: { command: "node", cwd: "${PLUGIN_DATA}" } }, "cursor"),
    ).toThrow(
      'Target "t" plugin "p": MCP server "s" uses ${PLUGIN_DATA}, but Cursor has no plugin-data variable.',
    );
  });
});

describe("renderMcpConfig: agent-plugins dialect", () => {
  it("converts Claude-style config to the portable shape", () => {
    expect(render(claudeStyle, "agent-plugins")).toEqual({
      $schema: AGENT_PLUGINS_MCP_SCHEMA,
      mcpServers: agentPluginsStyle,
    });
  });

  it("puts $schema first and type first in each server", () => {
    const output = render(
      { s: { args: ["a"], command: "node" } },
      "agent-plugins",
    );
    expect(Object.keys(output)).toEqual(["$schema", "mcpServers"]);
    expect(
      Object.keys((output.mcpServers as Record<string, object>).s),
    ).toEqual(["type", "command", "args"]);
  });

  it.each([
    [{ command: "x" }, "stdio"],
    [{ url: "https://example.com/mcp" }, "streamable-http"],
    [{ type: "http", url: "https://example.com/mcp" }, "streamable-http"],
    [{ type: "sse", url: "https://example.com/sse" }, "sse"],
  ])("infers or maps the transport for %j", (server, type) => {
    const servers = render({ s: server }, "agent-plugins").mcpServers as Record<
      string,
      Record<string, unknown>
    >;
    expect(servers.s.type).toBe(type);
  });

  it("turns a root-variable command into a plugin-relative one", () => {
    const servers = render(
      { s: { command: "${CURSOR_PLUGIN_ROOT}/bin/server" } },
      "agent-plugins",
    ).mcpServers;
    expect(servers).toEqual({ s: { type: "stdio", command: "./bin/server" } });
  });

  it("keeps valid cwd forms and normalizes their variables", () => {
    for (const [cwd, expected] of [
      ["./data", "./data"],
      ["${CLAUDE_PLUGIN_ROOT}", "${PLUGIN_ROOT}"],
      ["${CLAUDE_PLUGIN_DATA}/state", "${PLUGIN_DATA}/state"],
    ]) {
      const servers = render({ s: { command: "x", cwd } }, "agent-plugins")
        .mcpServers as Record<string, Record<string, unknown>>;
      expect(servers.s.cwd).toBe(expected);
    }
  });

  it.each([
    [
      "an unsupported transport",
      { type: "ws", url: "wss://example.com" },
      'has type "ws"; Agent Plugins supports "stdio", "streamable-http", and "sse".',
    ],
    [
      "a shell command string",
      { command: "node server.js" },
      "requires a single executable token",
    ],
    [
      "an absolute command",
      { command: "/usr/bin/node" },
      "requires a single executable token",
    ],
    [
      "a placeholder inside command",
      { command: "${HOME}/bin/x" },
      'does not expand placeholders in "command"',
    ],
    [
      "a command that escapes the plugin",
      { command: "./../outside" },
      "must stay inside the plugin root",
    ],
    [
      "a field outside the variant",
      { command: "x", url: "https://example.com" },
      'has field "url", which the Agent Plugins stdio server shape does not allow',
    ],
    [
      "a bare relative cwd",
      { command: "x", cwd: "data" },
      "Agent Plugins requires a ./ path or a path under ${PLUGIN_ROOT} or ${PLUGIN_DATA}",
    ],
    [
      "a cwd that escapes the plugin",
      { command: "x", cwd: "${PLUGIN_ROOT}/../up" },
      "that stays inside it",
    ],
    [
      "a reserved env name",
      { command: "x", env: { PLUGIN_ROOT: "/tmp" } },
      "sets PLUGIN_ROOT, which Agent Plugins reserves for the client.",
    ],
    [
      "an env reference the client won't expand",
      { command: "x", env: { TOKEN: "${API_TOKEN}" } },
      '"env.TOKEN" uses ${API_TOKEN}; Agent Plugins expands only ${PLUGIN_ROOT} and ${PLUGIN_DATA}',
    ],
    [
      "plain http to a remote host",
      { url: "http://example.com/mcp" },
      "uses http for a non-loopback host",
    ],
    [
      "credentials in the url",
      { url: "https://user:pw@example.com/mcp" },
      "must not contain user information or a fragment",
    ],
    [
      "a placeholder in a header",
      { url: "https://example.com", headers: { Authorization: "${TOKEN}" } },
      "does not expand placeholders in headers",
    ],
    [
      "a header repeated with different casing",
      { url: "https://example.com", headers: { "X-A": "1", "x-a": "2" } },
      'sets header "x-a" more than once',
    ],
    [
      "neither command nor url",
      { env: {} },
      'needs a "command" (stdio) or a "url" (remote).',
    ],
  ])("rejects %s", (_label, server, message) => {
    expect(() => render({ s: server }, "agent-plugins")).toThrow(message);
  });

  it("allows plain http to loopback hosts", () => {
    for (const url of [
      "http://localhost:3000/mcp",
      "http://127.0.0.1:3000/mcp",
      "http://[::1]:3000/mcp",
    ]) {
      expect(() => render({ s: { url } }, "agent-plugins")).not.toThrow();
    }
  });

  it("names the target, plugin, and server in errors", () => {
    expect(() =>
      render({ broken: { command: "a b" } }, "agent-plugins"),
    ).toThrow('Target "t" plugin "p": MCP server "broken" "command"');
  });
});
