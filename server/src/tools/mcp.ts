import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { McpManager } from "../services/mcp.js";

const SERVER_PARAM = Type.String({ description: "Name of an installed MCP server (see mcp_list_servers)" });

/**
 * Generic MCP access for the agents. Tools are not mirrored one-to-one into Pi
 * (its tool registry is fixed per session); instead the model lists a server's
 * tools with their schemas and invokes them through mcp_call.
 */
export function createMcpTools(mcp: McpManager) {
  const install = defineTool({
    name: "mcp_install",
    label: "Install MCP Server",
    description:
      "Install an MCP server from a GitHub URL (e.g. https://github.com/org/repo/tree/main/mcp — the ref and subdirectory are read from the URL), any git URL, or a local path, then start it and register it so its tools can be called with mcp_call. Node projects are built automatically (npm install, npm run build, entry point from package.json bin/main); pass command/args for anything else. Pass env for the configuration the server's README asks for (API URLs, tokens) — values are stored encrypted. Remote servers: transport=\"http\" with the endpoint as source. Returns the tool list. Ask the user (ask_user) for any credentials the server needs rather than guessing.",
    parameters: Type.Object({
      source: Type.String({ description: "GitHub tree/blob URL, git URL, local path, or http(s) MCP endpoint" }),
      name: Type.Optional(Type.String({ description: "Registered name (default: derived from the URL)" })),
      transport: Type.Optional(StringEnum(["stdio", "http"], { description: "stdio (default; installed locally) or http (remote endpoint)" })),
      subpath: Type.Optional(Type.String({ description: "Directory inside the repo holding the server (default: from the URL, else the root)" })),
      ref: Type.Optional(Type.String({ description: "Branch, tag or commit (default: from the URL, else the default branch)" })),
      command: Type.Optional(Type.String({ description: "Launch command override (e.g. \"uv\" or \"python\")" })),
      args: Type.Optional(Type.Array(Type.String(), { description: "Arguments for the launch command" })),
      env: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Environment variables for the server process (name → value)" })),
      headers: Type.Optional(Type.Object({}, { additionalProperties: true, description: "HTTP headers for http servers (e.g. Authorization)" })),
    }),
    execute: async (_id, params, signal, onUpdate) => {
      const status = await mcp.install(
        {
          source: params.source,
          name: params.name,
          transport: params.transport as "stdio" | "http" | undefined,
          subpath: params.subpath,
          ref: params.ref,
          command: params.command,
          args: params.args,
          env: stringMap(params.env),
          headers: stringMap(params.headers),
        },
        {
          signal,
          log: (line) => onUpdate?.({ content: [{ type: "text", text: line }], details: {} }),
        },
      );
      const tools = status.tools.map((t) => `- ${t.name}${t.description ? ` — ${firstLine(t.description)}` : ""}`);
      return {
        content: [
          {
            type: "text",
            text: [
              `Installed MCP server "${status.name}" (${status.transport}${status.path ? `, ${status.path}` : ""}${status.url ? `, ${status.url}` : ""}).`,
              `${status.tools.length} tool(s):`,
              ...tools,
              "",
              `Call them with mcp_call(server: "${status.name}", tool: <name>, arguments: {...}); mcp_list_tools gives the argument schemas.`,
            ].join("\n"),
          },
        ],
        details: { name: status.name, toolCount: status.tools.length },
      };
    },
  });

  const remove = defineTool({
    name: "mcp_remove",
    label: "Remove MCP Server",
    description:
      "Stop an installed MCP server, drop it from the registry and delete its install directory. Confirm with the user (ask_user) unless they explicitly asked for the removal.",
    parameters: Type.Object({ server: SERVER_PARAM }),
    execute: async (_id, params) => {
      const r = await mcp.remove(params.server);
      return {
        content: [{ type: "text", text: `Removed MCP server "${r.name}"${r.path ? ` and deleted ${r.path}` : ""}.` }],
        details: { name: r.name },
      };
    },
  });

  const listServers = defineTool({
    name: "mcp_list_servers",
    label: "List MCP Servers",
    description: "List the installed MCP servers with their connection state and tool names.",
    parameters: Type.Object({}),
    execute: async () => {
      const statuses = await mcp.statuses();
      const text = statuses.length
        ? statuses
            .map((s) => {
              const state = s.status === "connected" ? "connected" : `${s.status}${s.error ? `: ${s.error}` : ""}`;
              return `- ${s.name} (${s.transport}, ${state}) — ${s.tools.length} tool(s): ${s.tools.map((t) => t.name).join(", ") || "(none)"}`;
            })
            .join("\n")
        : "No MCP servers installed. Use mcp_install with a GitHub URL to add one.";
      return { content: [{ type: "text", text }], details: { count: statuses.length } };
    },
  });

  const listTools = defineTool({
    name: "mcp_list_tools",
    label: "List MCP Tools",
    description:
      "List the tools an installed MCP server offers, with descriptions and JSON-schema argument definitions. Starts the server if it is not running.",
    parameters: Type.Object({ server: SERVER_PARAM }),
    execute: async (_id, params) => {
      const tools = await mcp.listTools(params.server);
      const text = tools.length
        ? tools
            .map((t) => {
              const flags = [
                t.annotations?.readOnlyHint === true ? "read-only" : null,
                t.annotations?.destructiveHint === true ? "DESTRUCTIVE" : null,
              ].filter(Boolean);
              return [
                `### ${t.name}${flags.length ? ` (${flags.join(", ")})` : ""}`,
                t.description ?? "",
                "arguments: " + JSON.stringify(t.inputSchema ?? { type: "object" }),
              ].join("\n");
            })
            .join("\n\n")
        : `"${params.server}" advertises no tools.`;
      return { content: [{ type: "text", text }], details: { count: tools.length } };
    },
  });

  const call = defineTool({
    name: "mcp_call",
    label: "Call MCP Tool",
    description:
      "Invoke a tool on an installed MCP server. Check the argument schema with mcp_list_tools first. Tools whose description says DESTRUCTIVE change external systems — confirm with the user before calling them.",
    parameters: Type.Object({
      server: SERVER_PARAM,
      tool: Type.String({ description: "Tool name as listed by mcp_list_tools" }),
      arguments: Type.Optional(
        Type.Object({}, { additionalProperties: true, description: "Arguments matching the tool's input schema" }),
      ),
    }),
    execute: async (_id, params, signal) => {
      const text = await mcp.callTool(
        params.server,
        params.tool,
        (params.arguments as Record<string, unknown> | undefined) ?? {},
        signal,
      );
      return { content: [{ type: "text", text }], details: { server: params.server, tool: params.tool } };
    },
  });

  return [install, remove, listServers, listTools, call];
}

function stringMap(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val == null) continue;
    out[k] = typeof val === "string" ? val : String(val);
  }
  return out;
}

function firstLine(s: string): string {
  const line = s.split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

export const MCP_TOOL_NAMES = ["mcp_install", "mcp_remove", "mcp_list_servers", "mcp_list_tools", "mcp_call"];
/** Change the set of installed servers or the machine; blocked in plan mode. */
export const MCP_MUTATING_TOOLS = ["mcp_install", "mcp_remove"];
/** Never change anything: safe for read-only subagents and plan mode. */
export const MCP_READONLY_TOOL_NAMES = ["mcp_list_servers", "mcp_list_tools"];
