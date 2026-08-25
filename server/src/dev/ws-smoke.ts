/**
 * Scripted WebSocket client that exercises the full server: creates a thread,
 * prompts, answers a question, runs the plan flow, and replays history.
 * Expects the server to already be running in mock mode:
 *   FASTCAR_MOCK=1 DATABASE_URL=... npm run dev
 * Then:
 *   npm run smoke:ws
 */
import WebSocket from "ws";
import type {
  ClientMessage,
  CommandsResponse,
  MentionsResponse,
  ServerMessage,
  ThreadHistoryResponse,
} from "@fastcar/shared";
import { REASONING_EFFORTS, type AppSettingsResponse, type ReasoningEffort } from "@fastcar/shared";

const BASE = process.env.FASTCAR_URL ?? "http://localhost:3000";
/** The mock OpenAI server behind the target (FASTCAR_MOCK_PORT of that server). */
const MOCK_BASE = `http://127.0.0.1:${process.env.FASTCAR_MOCK_PORT ?? 3210}`;
const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws`);

const received: ServerMessage[] = [];
let threadId = "";

function send(msg: ClientMessage): void {
  ws.send(JSON.stringify(msg));
}

function waitFor<T extends ServerMessage["type"]>(
  type: T,
  pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  timeoutMs = 30_000,
): Promise<Extract<ServerMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for ${type}`)),
      timeoutMs,
    );
    const check = (m: ServerMessage) => {
      if (m.type === type && pred(m as Extract<ServerMessage, { type: T }>)) {
        clearTimeout(timer);
        listeners.delete(check);
        resolve(m as Extract<ServerMessage, { type: T }>);
      }
    };
    listeners.add(check);
  });
}

const listeners = new Set<(m: ServerMessage) => void>();
ws.on("message", (raw: Buffer) => {
  const msg = JSON.parse(raw.toString()) as ServerMessage;
  received.push(msg);
  for (const l of [...listeners]) l(msg);
});

function assert(cond: unknown, label: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  console.log(`ok: ${label}`);
}

ws.on("open", () => {
  void (async () => {
    await waitFor("hello");
    assert(true, "received hello with thread list");

    // 1. Basic prompt flow
    send({ type: "create_thread" });
    const created = await waitFor("thread_created");
    threadId = created.thread.id;
    send({ type: "prompt", threadId, text: "hello, look around" });
    await waitFor("status", (m) => m.threadId === threadId && m.status === "running");
    await waitFor(
      "event",
      (m) => m.threadId === threadId && m.ev.kind === "tool_end",
    );
    await waitFor("status", (m) => m.threadId === threadId && m.status === "idle");
    assert(true, "prompt → tool call → idle");

    // 2. ask_user round trip
    send({ type: "prompt", threadId, text: "ask me something please" });
    const q = await waitFor("question", (m) => m.threadId === threadId);
    send({ type: "answer_question", threadId, questionId: q.questionId, answer: "vanilla" });
    await waitFor("status", (m) => m.threadId === threadId && m.status === "idle");
    assert(true, "question answered and run completed");

    // 3. plan flow
    send({ type: "create_thread", mode: "plan" });
    const planThread = (await waitFor("thread_created", (m) => m.thread.mode === "plan")).thread.id;
    send({ type: "prompt", threadId: planThread, text: "plan a refactor" });
    const plan = await waitFor("plan_ready", (m) => m.threadId === planThread, 30_000);
    assert(plan.planMarkdown.includes("Plan"), "plan submitted and surfaced");
    send({ type: "approve_plan", threadId: planThread });
    await waitFor("status", (m) => m.threadId === planThread && m.status === "idle", 30_000);
    assert(true, "plan approved and executed");

    // 3b. plan flow with a read-only planning subagent: the plan-mode gate must
    //     let run_subagent(maxcoding, mode=plan) through, and the plan follows.
    send({ type: "create_thread", mode: "plan" });
    const planThread2 = (
      await waitFor("thread_created", (m) => m.thread.mode === "plan" && m.thread.id !== planThread)
    ).thread.id;
    send({ type: "prompt", threadId: planThread2, text: "delegate planning for a refactor" });
    await waitFor(
      "event",
      (m) => m.threadId === planThread2 && m.agent === "maxcoding" && m.ev.kind === "tool_start",
      60_000,
    );
    assert(true, "plan mode allows a read-only maxcoding planning subagent");
    const subPlan = await waitFor(
      "event",
      (m) =>
        m.threadId === planThread2 &&
        m.agent === "conductor" &&
        m.ev.kind === "tool_end" &&
        m.ev.result.includes("## Questions for the user"),
      60_000,
    );
    assert(subPlan != null, "planning subagent returned questions for the user");
    const plan2 = await waitFor("plan_ready", (m) => m.threadId === planThread2, 30_000);
    assert(plan2.planMarkdown.includes("Plan"), "conductor still submits the plan after delegating");
    send({ type: "approve_plan", threadId: planThread2 });
    await waitFor("status", (m) => m.threadId === planThread2 && m.status === "idle", 30_000);

    // 4. subagent delegation
    send({ type: "prompt", threadId, text: "please delegate this exploration" });
    const sub = await waitFor(
      "event",
      (m) => m.threadId === threadId && m.agent === "minimodel",
    );
    assert(sub.taskId != null, "subagent events carry taskId");
    await waitFor("status", (m) => m.threadId === threadId && m.status === "idle", 60_000);
    assert(true, "delegation completed");

    // 4b. conductor settings round-trip (reasoning effort); restore afterwards
    const settingsBefore = (await (await fetch(`${BASE}/api/settings`)).json()) as AppSettingsResponse;
    assert(
      REASONING_EFFORTS.includes(settingsBefore.conductor.reasoningEffort),
      "GET /api/settings reports the conductor reasoning effort",
    );
    const flipped: ReasoningEffort = settingsBefore.conductor.reasoningEffort === "high" ? "medium" : "high";
    const setRes = await fetch(`${BASE}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conductor: { reasoningEffort: flipped } }),
    });
    assert(setRes.ok, "POST /api/settings accepts a reasoning effort");
    const settingsAfter = (await (await fetch(`${BASE}/api/settings`)).json()) as AppSettingsResponse;
    assert(settingsAfter.conductor.reasoningEffort === flipped, "reasoning effort persisted");
    // The already-running conductor on `threadId` must carry the new effort on
    // its next turn — check the mock's request log when the mock is reachable.
    send({ type: "prompt", threadId, text: "hello again" });
    await waitFor("status", (m) => m.threadId === threadId && m.status === "idle", 30_000);
    const mockLog = await fetch(`${MOCK_BASE}/__mock/requests`).then(
      (r) => r.json() as Promise<{ requests: Array<{ model: string; reasoning_effort?: string }> }>,
      () => null,
    );
    if (mockLog) {
      const conductorModel = settingsAfter.conductor.model.split("/")[1];
      const lastConductorReq = [...mockLog.requests].reverse().find((r) => r.model === conductorModel);
      assert(
        lastConductorReq?.reasoning_effort === flipped,
        `live conductor sent reasoning_effort=${flipped} (saw ${lastConductorReq?.reasoning_effort ?? "nothing"})`,
      );
    } else {
      console.log(`  (mock request log not reachable at ${MOCK_BASE}; skipped live-effort check)`);
    }
    const badRes = await fetch(`${BASE}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conductor: { reasoningEffort: "turbo" } }),
    });
    assert(badRes.status === 400, "POST /api/settings rejects an unknown effort");
    await fetch(`${BASE}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conductor: { reasoningEffort: settingsBefore.conductor.reasoningEffort } }),
    });

    // 5. slash commands and @-mention sources
    const commands = (
      (await (await fetch(`${BASE}/api/commands`)).json()) as CommandsResponse
    ).commands;
    assert(
      commands.some((c) => c.name === "help") && commands.some((c) => c.name === "compact"),
      "GET /api/commands lists the registry",
    );

    const systemText = async (name: string, args?: string): Promise<string> => {
      send({ type: "command", threadId, name, args });
      const ev = await waitFor(
        "event",
        (m) => m.threadId === threadId && m.ev.kind === "system",
      );
      return ev.ev.kind === "system" ? ev.ev.text : "";
    };

    assert((await systemText("help")).includes("/compact"), "/help renders the command list");
    assert(
      (await systemText("nope")).includes("Unknown command"),
      "unknown commands report themselves",
    );
    assert((await systemText("context")).includes("Context"), "/context reports session usage");
    assert((await systemText("agents")).includes("maxcoding"), "/agents lists the subagents");

    // Fired back to back on purpose: each WS frame is handled in its own async
    // task, so the manager has to queue them per thread rather than interleave.
    send({ type: "command", threadId, name: "plan" });
    send({ type: "command", threadId, name: "act" });
    await waitFor("status", (m) => m.threadId === threadId && m.mode === "plan");
    await waitFor("status", (m) => m.threadId === threadId && m.mode === "act");
    assert(true, "/plan and /act queue in order instead of racing");

    const mentions = (
      (await (await fetch(`${BASE}/api/mentions?q=maxc`)).json()) as MentionsResponse
    ).items;
    assert(
      mentions.some((m) => m.kind === "agent" && m.value === "maxcoding"),
      "GET /api/mentions resolves @maxc → the maxcoding subagent",
    );

    // 6. delegated coding work has to come back verified
    send({ type: "prompt", threadId, text: "please implement the mock widget" });
    await waitFor(
      "event",
      (m) => m.threadId === threadId && m.agent === "maxcoding" && m.ev.kind === "tool_start",
      60_000,
    );
    await waitFor(
      "event",
      (m) =>
        m.threadId === threadId &&
        m.agent === "conductor" &&
        m.ev.kind === "tool_end" &&
        m.ev.result.includes("## Verification"),
      90_000,
    );
    assert(true, "a coding subagent that skipped verification is sent back to run the checks");
    await waitFor("status", (m) => m.threadId === threadId && m.status === "idle", 60_000);

    // 7. rename and delete threads
    send({ type: "rename_thread", threadId, title: "  Renamed   by  smoke  " });
    const renamed = await waitFor(
      "thread_updated",
      (m) => m.thread.id === threadId && m.thread.title === "Renamed by smoke",
    );
    assert(renamed.thread.title === "Renamed by smoke", "rename normalizes and applies the title");

    assert(
      (await systemText("rename", "Renamed by command")).includes("Renamed by command"),
      "/rename renames the thread",
    );

    send({ type: "create_thread" });
    const doomed = (await waitFor("thread_created", (m) => m.thread.title === "New thread")).thread
      .id;
    send({ type: "prompt", threadId: doomed, text: "hello, look around" });
    await waitFor("status", (m) => m.threadId === doomed && m.status === "idle", 60_000);
    send({ type: "delete_thread", threadId: doomed });
    await waitFor("thread_deleted", (m) => m.threadId === doomed);
    const afterDelete = (await (await fetch(`${BASE}/api/threads`)).json()) as {
      threads: Array<{ id: string }>;
    };
    assert(
      !afterDelete.threads.some((t) => t.id === doomed),
      "deleted thread is gone from GET /api/threads",
    );
    assert(
      (await fetch(`${BASE}/api/threads/${doomed}/events`)).status === 404,
      "deleted thread's history is gone too",
    );

    // Deleting mid-run: the run must unwind without writing events for a row
    // that is on its way out (this raced the events foreign key once).
    send({ type: "create_thread" });
    const midRun = (await waitFor("thread_created", (m) => m.thread.title === "New thread")).thread
      .id;
    send({ type: "prompt", threadId: midRun, text: "hello, look around" });
    await waitFor("status", (m) => m.threadId === midRun && m.status === "running");
    send({ type: "delete_thread", threadId: midRun });
    await waitFor("thread_deleted", (m) => m.threadId === midRun);
    assert(
      (await fetch(`${BASE}/api/threads/${midRun}/events`)).status === 404,
      "a thread deleted mid-run is removed cleanly",
    );

    // 8. add repo via the agent (mock emits git_clone with the URL from the prompt)
    const missingPurge = await fetch(`${BASE}/api/repos/definitely-not-a-repo`, {
      method: "DELETE",
    });
    assert(missingPurge.status === 404, "purging an unknown repository is a 404");

    // MCP: install a server through the agent, call one of its tools, remove it.
    // FASTCAR_SMOKE_MCP_SOURCE is a git repo (URL or path) with the echo fixture
    // under mcp/ — see src/test/fixtures/mcp-echo and mcp.test.ts.
    const mcpSource = process.env.FASTCAR_SMOKE_MCP_SOURCE;
    if (mcpSource) {
      send({ type: "prompt", threadId, text: `install the mcp server ${mcpSource}` });
      const installed = await waitFor(
        "mcp_servers_updated",
        (m) => m.servers.some((s) => s.name === "mcp-echo" && s.status === "connected"),
        120_000,
      );
      const echo = installed.servers.find((s) => s.name === "mcp-echo")!;
      assert(echo.tools.some((t) => t.name === "echo"), "agent installed an MCP server and it advertises tools");
      await waitFor("status", (m) => m.threadId === threadId && m.status === "idle", 60_000);
      send({ type: "prompt", threadId, text: "call the mcp echo tool" });
      await waitFor(
        "event",
        (m) =>
          m.threadId === threadId &&
          m.agent === "conductor" &&
          m.ev.kind === "tool_end" &&
          m.ev.result.includes("echo from mock"),
        60_000,
      );
      assert(true, "agent called an MCP tool and got its result");
      await waitFor("status", (m) => m.threadId === threadId && m.status === "idle", 60_000);
      const mcpList = (await (await fetch(`${BASE}/api/mcp`)).json()) as { servers: Array<{ name: string }> };
      assert(mcpList.servers.some((s) => s.name === "mcp-echo"), "GET /api/mcp lists the server");
      // Listen before deleting: the broadcast can land while the fetch is still pending.
      const removed = waitFor("mcp_servers_updated", (m) => !m.servers.some((s) => s.name === "mcp-echo"), 30_000);
      const del = await fetch(`${BASE}/api/mcp/mcp-echo`, { method: "DELETE" });
      assert(del.ok, "DELETE /api/mcp/:name removes the server");
      await removed;
      assert(true, "removal is broadcast to the UI");
    }

    const bareRepo = process.env.FASTCAR_SMOKE_BARE_REPO;
    if (bareRepo) {
      const repoName = `wssmoke-${Date.now()}`;
      send({ type: "add_repo", url: bareRepo, name: repoName });
      const repos = await waitFor(
        "repos_updated",
        (m) => m.repos.some((r) => r.name === repoName),
        60_000,
      );
      const repo = repos.repos.find((r) => r.name === repoName)!;
      assert(repo.branch != null, `repo cloned via agent and status reports branch (${repo.branch})`);
      const reposRes = await fetch(`${BASE}/api/repos`);
      const reposJson = (await reposRes.json()) as { repos: Array<{ name: string }> };
      assert(
        reposJson.repos.some((r) => r.name === repoName),
        "GET /api/repos lists the new repository",
      );

      // Purge it again over REST — this also keeps the suite from leaving
      // clones behind on the dev box.
      const purged = await fetch(`${BASE}/api/repos/${repoName}`, { method: "DELETE" });
      assert(purged.ok, "DELETE /api/repos/:name purges a clean clone");
      await waitFor("repos_updated", (m) => !m.repos.some((r) => r.name === repoName), 30_000);
      assert(true, "purge broadcasts the updated repository list");
    } else {
      console.log("skip: add_repo flow (set FASTCAR_SMOKE_BARE_REPO to enable)");
    }

    // 9. history replay
    const res = await fetch(`${BASE}/api/threads/${threadId}/events`);
    const history = (await res.json()) as ThreadHistoryResponse;
    assert(history.events.some((e) => e.kind === "user_message"), "history has user messages");
    assert(history.events.some((e) => e.kind === "tool_call"), "history has tool calls");
    assert(history.events.some((e) => e.kind === "assistant_text"), "history has assistant text");
    assert(history.events.some((e) => e.kind === "system"), "history has slash command output");
    assert(
      history.events.some((e) => e.agent === "minimodel"),
      "history has subagent rows",
    );
    const seqs = history.events.map((e) => e.seq);
    assert(
      seqs.every((s, i) => i === 0 || s > seqs[i - 1]!),
      "event seq strictly increasing",
    );

    console.log("\nALL WS SMOKE TESTS PASSED");
    ws.close();
    process.exit(0);
  })().catch((err) => {
    console.error(err);
    console.error("last 5 messages:", JSON.stringify(received.slice(-5), null, 2));
    process.exit(1);
  });
});
