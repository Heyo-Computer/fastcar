import http from "node:http";
import { getAgent } from "../pi/agentsConfig.js";

/**
 * Minimal OpenAI-compatible mock server so the full stack (real Pi loop, real
 * tools, real WS protocol, real UI) can run with no API keys. Responses are
 * scripted off the incoming conversation:
 *  - default: one `ls` tool call, then a final text message
 *  - prompt contains "ask"       -> ask_user tool call (if the tool is offered)
 *  - prompt contains "delegate"  -> run_subagent(minimodel) call (if offered)
 *  - prompt contains "implement" -> run_subagent(maxcoding) call (if offered)
 *  - maxcoding subagent          -> a `bash` call and a report with no
 *    verification, so the harness's verification follow-up fires; the reminder
 *    is answered with a "## Verification" section
 *  - planning-mode system prompt -> submit_plan call (if offered)
 * Also implements POST .../audio/transcriptions with a canned transcript.
 */

interface ChatMessage {
  role: string;
  content: unknown;
  tool_calls?: unknown[];
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: Array<{ function?: { name?: string } }>;
  stream?: boolean;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && "text" in p ? String((p as any).text) : ""))
      .join(" ");
  }
  return "";
}

type Reply =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; args: Record<string, unknown> };

function decideReply(req: ChatRequest): Reply {
  const toolNames = new Set(
    (req.tools ?? []).map((t) => t.function?.name).filter((n): n is string => !!n),
  );
  const systemText = req.messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => contentToText(m.content))
    .join("\n");
  const lastMessage = req.messages[req.messages.length - 1];
  const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
  const rawUserText = contentToText(lastUser?.content ?? "");
  const userText = rawUserText.toLowerCase();
  const hadToolResult = req.messages.some((m) => m.role === "tool");

  // The harness sends this back to a coding subagent that changed something and
  // reported no verification. Answer it the way the contract requires.
  if (userText.includes("missing the required")) {
    return {
      kind: "text",
      text: "## Verification\n- `npm test` — passed (mock: 12 tests)\n- `npm run typecheck` — passed (mock)",
    };
  }

  // After any tool result, wrap up with text (keeps the loop short and predictable).
  if (lastMessage?.role === "tool") {
    return { kind: "text", text: "Mock run complete. I inspected the workspace and finished the task." };
  }

  if (systemText.includes("PLANNING MODE") && toolNames.has("submit_plan")) {
    return {
      kind: "tool",
      name: "submit_plan",
      args: {
        plan: "# Mock Plan\n\n1. Inspect the repository.\n2. Make the change.\n3. Verify with tests.",
      },
    };
  }
  if (userText.includes("ask") && toolNames.has("ask_user")) {
    return {
      kind: "tool",
      name: "ask_user",
      args: { question: "Mock question: which flavor do you want?", options: ["vanilla", "chocolate"] },
    };
  }
  if (userText.includes("delegate") && toolNames.has("run_subagent")) {
    return {
      kind: "tool",
      name: "run_subagent",
      args: { agent: getAgent("small_task"), task: "Summarize the contents of the current directory." },
    };
  }
  if (userText.includes("implement") && toolNames.has("run_subagent")) {
    return {
      kind: "tool",
      name: "run_subagent",
      args: {
        agent: getAgent("coding"),
        task: "Implement the requested change. Acceptance: the project's tests and typecheck pass. Verify with npm test and npm run typecheck.",
      },
    };
  }
  // The coding subagent changes something first — that is what makes the
  // harness require verification before it accepts the report.
  if (systemText.includes("senior software engineer") && toolNames.has("bash")) {
    return { kind: "tool", name: "bash", args: { command: "echo mock edit applied" } };
  }
  if (userText.includes("remember") && toolNames.has("memory_save")) {
    return {
      kind: "tool",
      name: "memory_save",
      args: { content: "Mock memory: the user likes concise answers.", tags: ["mock"] },
    };
  }
  // Match against the raw (case-preserving) text — URLs and paths are case-sensitive.
  const cloneMatch = /[Aa]dd the git repository (\S+)/.exec(rawUserText);
  if (cloneMatch && toolNames.has("git_clone")) {
    const nameMatch = /under the name "([^"]+)"/.exec(rawUserText);
    return {
      kind: "tool",
      name: "git_clone",
      args: nameMatch ? { url: cloneMatch[1], name: nameMatch[1] } : { url: cloneMatch[1] },
    };
  }
  if (!hadToolResult && toolNames.has("ls")) {
    return { kind: "tool", name: "ls", args: { path: "." } };
  }
  return { kind: "text", text: `Mock response to: ${userText || "(empty prompt)"}` };
}

function sseChunk(res: http.ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function streamReply(res: http.ServerResponse, model: string, reply: Reply): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const base = {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
  };
  if (reply.kind === "text") {
    sseChunk(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] });
    for (const word of reply.text.split(/(?<= )/)) {
      sseChunk(res, { ...base, choices: [{ index: 0, delta: { content: word } }] });
    }
    sseChunk(res, {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
    });
  } else {
    sseChunk(res, {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${Math.random().toString(36).slice(2, 10)}`,
                type: "function",
                function: { name: reply.name, arguments: "" },
              },
            ],
          },
        },
      ],
    });
    sseChunk(res, {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.args) } }],
          },
        },
      ],
    });
    sseChunk(res, {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    });
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export function startMockOpenAI(port: number): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "";
    try {
      if (req.method === "POST" && url.endsWith("/chat/completions")) {
        const body = JSON.parse((await readBody(req)).toString()) as ChatRequest;
        const reply = decideReply(body);
        if (body.stream === false) {
          const message =
            reply.kind === "text"
              ? { role: "assistant", content: reply.text }
              : {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_mock",
                      type: "function",
                      function: { name: reply.name, arguments: JSON.stringify(reply.args) },
                    },
                  ],
                };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: "chatcmpl-mock",
              object: "chat.completion",
              model: body.model,
              choices: [
                {
                  index: 0,
                  message,
                  finish_reason: reply.kind === "text" ? "stop" : "tool_calls",
                },
              ],
              usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
            }),
          );
          return;
        }
        streamReply(res, body.model, reply);
        return;
      }
      if (req.method === "POST" && url.endsWith("/audio/transcriptions")) {
        await readBody(req);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text: "This is a mock transcript of your recording." }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `mock: no route for ${req.method} ${url}` }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      console.log(`mock OpenAI server on 127.0.0.1:${port}`);
      resolve(server);
    });
  });
}
