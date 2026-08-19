import type { FastifyInstance } from "fastify";
import type { ClientMessage, ServerMessage } from "@fastcar/shared";
import { listThreads, toMeta } from "../db/threads.js";
import { callerFromRequest } from "../http/auth.js";
import type { Config } from "../config.js";
import type { ThreadManager } from "../threads/manager.js";

export function registerWs(app: FastifyInstance, manager: ThreadManager, cfg: Config): void {
  app.get("/ws", { websocket: true }, (socket) => {
    const send = (msg: ServerMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    const removeClient = manager.addClient(send);

    void listThreads().then((threads) => send({ type: "hello", threads: threads.map(toMeta) }));

    socket.on("message", (raw: Buffer) => {
      void (async () => {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(raw.toString()) as ClientMessage;
        } catch {
          send({ type: "error", message: "invalid JSON" });
          return;
        }
        // WS connections carry no HTTP headers, so caller identity for the
        // admin-only `/email` slash command is taken from the message payload's
        // optional `adminToken` field. Missing/blank token means single-user
        // dev mode (no restriction) when FASTCAR_ADMIN_TOKEN is unset.
        const isWsAdmin = (token: string | undefined): boolean => {
          if (!cfg.adminToken) return true; // dev mode: no auth configured
          return Boolean(token) && token === cfg.adminToken;
        };
        try {
          switch (msg.type) {
            case "create_thread":
              await manager.createThread(msg.mode ?? "act");
              break;
            case "create_prompt_thread":
              await manager.createPromptThread({
                title: msg.title,
                templateId: msg.templateId,
                variables: msg.variables,
                webhookUrl: msg.webhookUrl,
                webhookToken: msg.webhookToken,
              });
              break;
            case "prompt":
              await manager.prompt(msg.threadId, msg.text);
              break;
            case "command":
              await manager.command(msg.threadId, msg.name, msg.args ?? "");
              break;
            case "slash": {
              // Feature 2: structured slash command. Currently `/email`.
              const command = msg.command.replace(/^\//, "").toLowerCase();
              if (command === "email") {
                if (!isWsAdmin(msg.adminToken)) {
                  send({ type: "slash_result", ok: false, message: "admin only" });
                  break;
                }
                const args = (msg.args ?? {}) as { to?: string; subject?: string; body?: string };
                if (!args.to || !args.subject || !args.body) {
                  send({
                    type: "slash_result",
                    ok: false,
                    message: "/email requires to, subject, and body",
                  });
                  break;
                }
                if (msg.threadId) {
                  await manager.emailSlash(msg.threadId, {
                    to: args.to,
                    subject: args.subject,
                    body: args.body,
                  });
                  send({ type: "slash_result", ok: true, message: `email queued for ${args.to}` });
                } else {
                  const result = await manager.sendEmailDirect(args.to, args.subject, args.body);
                  send({ type: "slash_result", ok: result.ok, message: result.message });
                }
              } else {
                send({ type: "slash_result", ok: false, message: `unknown slash command: /${command}` });
              }
              break;
            }
            case "rename_thread":
              await manager.renameThread(msg.threadId, msg.title);
              break;
            case "delete_thread":
              await manager.deleteThread(msg.threadId);
              break;
            case "set_mode":
              await manager.setMode(msg.threadId, msg.mode);
              break;
            case "answer_question":
              await manager.answerQuestion(msg.threadId, msg.questionId, msg.answer);
              break;
            case "approve_plan":
              await manager.approvePlan(msg.threadId);
              break;
            case "reject_plan":
              await manager.rejectPlan(msg.threadId, msg.feedback);
              break;
            case "abort":
              await manager.abort(msg.threadId);
              break;
            case "steer":
              await manager.steer(msg.threadId, msg.text);
              break;
            case "add_repo":
              await manager.addRepo(msg.url, msg.name, msg.threadId);
              break;
            default:
              send({ type: "error", message: `unknown message type` });
          }
        } catch (err) {
          send({
            type: "error",
            threadId: "threadId" in msg ? msg.threadId : undefined,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    });

    socket.on("close", removeClient);
    socket.on("error", removeClient);
  });
}
