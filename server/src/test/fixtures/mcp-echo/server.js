#!/usr/bin/env node
// A dependency-free MCP server over stdio (newline-delimited JSON-RPC), just
// enough of the protocol for the SDK client to initialize, list tools and call
// them. Used by mcp.test.ts so installs never touch the network.
import { createInterface } from "node:readline";

const TOOLS = [
  {
    name: "echo",
    description: "Echo the text back.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "shout",
    description: "DESTRUCTIVE (not really): upper-case the text.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
];

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const fail = (id, code, message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "mcp-echo", version: "0.0.1" },
      });
      break;
    case "ping":
      reply(id, {});
      break;
    case "tools/list":
      reply(id, { tools: TOOLS });
      break;
    case "tools/call": {
      const text = String(params?.arguments?.text ?? "");
      if (params?.name === "echo") reply(id, { content: [{ type: "text", text }] });
      else if (params?.name === "shout") reply(id, { content: [{ type: "text", text: text.toUpperCase() }] });
      else reply(id, { content: [{ type: "text", text: `unknown tool ${params?.name}` }], isError: true });
      break;
    }
    default:
      fail(id, -32601, `method not found: ${method}`);
  }
});
console.error(`mcp-echo ready (${process.env.ECHO_GREETING ?? "no greeting"})`);
