import { spawn } from "node:child_process";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

/**
 * `heyctl`: drive app-lb's admin API from inside the agent.
 *
 * heyctl is a kubectl-shaped CLI for app-lb — it lists, creates, scales and
 * describes deployments, their microVM pools, certificates, secrets, jobs and
 * disks, and runs commands inside a deployment's VM (`exec`/`shell`). It is
 * built in the VM image (deploy/image/Dockerfile) and lives at
 * /usr/local/bin/heyctl. This tool is a thin wrapper: the model names a
 * subcommand and an args array (exactly what it would type at a shell), and the
 * tool runs `heyctl <subcommand> <args...>` and returns stdout/stderr.
 *
 * Following the git.ts pattern: every call is one defineTool, the names that
 * mutate are exported for plan-mode gating, and the whole surface is one tool
 * (the model knows the verbs; the server does not try to mirror each one).
 *
 * Reads (get, describe, top, status, whoami, …) and writes (create, apply,
 * scale, set, delete, restart, …) are distinguished only by the
 * HEYCTL_MUTATING_TOOLS list below, which the conductor uses to block writes
 * in plan mode. The tool itself runs every subcommand the same way — heyctl is
 * the authority on what mutates, and the model is expected to treat anything
 * that changes deployments/VMs/certs as mutating.
 */

const EXEC_TIMEOUT_MS = 5 * 60 * 1000;
/** Per-stream cap so a streaming command (e.g. `top --watch`) cannot fill memory. */
const MAX_OUTPUT = 512 * 1024;

export function createHeyctlTools() {
  const heyctl = defineTool({
    name: "heyctl",
    label: "heyctl",
    description:
      "Run the heyctl CLI — a kubectl-shaped client for app-lb's admin API. Controls deployments, their microVM pools, certificates, secrets, jobs and disks, and runs commands inside a deployment's VM (`exec`, `shell`). Pass a subcommand and an args array exactly as you would at a shell (e.g. heyctl(subcommand: \"get\", args: [\"deployments\"])). Returns stdout and stderr. Read commands (get, describe, top, status, whoami) are safe in plan mode; anything that creates, scales, sets, applies, restarts, deletes or otherwise changes deployments/VMs/certs is mutating and blocked in plan mode. Run `heyctl <subcommand> --help` to discover an unfamiliar subcommand's flags before guessing.",
    parameters: Type.Object({
      subcommand: Type.String({
        description:
          "heyctl subcommand (e.g. get, describe, create, apply, scale, set, restart, delete, exec, shell, top, status, login, token, rollout, build, pull, edit, config). For nested subcommands (e.g. `token mint`), put the whole path here: subcommand=\"token mint\".",
      }),
      args: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Arguments after the subcommand, one per element — e.g. [\"--host\", \"web.local\", \"--image\", \"nginx-fc\"]. Flags and positional args both go here.",
        }),
      ),
      stdin: Type.Optional(
        Type.String({
          description:
            "Optional string piped to heyctl's stdin (e.g. a spec body for `heyctl apply -f -`). Omit for commands that take no input.",
        }),
      ),
    }),
    execute: async (_id, params, signal) => {
      // The subcommand is split so `token mint` works as one field the model
      // fills in naturally; the args array carries everything after it.
      const sub = (params.subcommand ?? "").trim();
      if (!sub) {
        return {
          content: [{ type: "text", text: "heyctl needs a subcommand (e.g. \"get\")." }],
          details: { exitCode: null as number | null, truncated: false },
        };
      }
      const cmdArgs = [...sub.split(/\s+/), ...(params.args ?? [])];

      const result = await runHeyctl(cmdArgs, params.stdin, signal);
      const text = formatResult(cmdArgs, result);
      return {
        content: [{ type: "text", text }],
        details: { exitCode: result.exitCode, truncated: result.truncated },
      };
    },
  });

  return [heyctl];
}

interface HeyctlResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** True if stdout or stderr exceeded MAX_OUTPUT and was truncated. */
  truncated: boolean;
  /** Set when the heyctl binary itself is missing. */
  missing?: boolean;
}

/** Append to a stream's accumulator, keeping only the last MAX_OUTPUT bytes once it overflows. */
function appendBounded(buf: Buffer, acc: string): { text: string; truncated: boolean } {
  const chunk = buf.toString();
  const combined = acc + chunk;
  if (combined.length <= MAX_OUTPUT) return { text: combined, truncated: false };
  return { text: combined.slice(combined.length - MAX_OUTPUT), truncated: true };
}

/**
 * Spawn heyctl with the given args, optionally feeding stdin. Resolves once the
 * process exits (or the signal aborts it). Output is bounded to MAX_OUTPUT per
 * stream so a runaway `top --watch` cannot fill memory; the tail is kept so the
 * error (usually at the end) survives.
 */
function runHeyctl(
  args: string[],
  stdin: string | undefined,
  signal?: AbortSignal,
): Promise<HeyctlResult> {
  return new Promise((resolve) => {
    const child = spawn("heyctl", args, {
      timeout: EXEC_TIMEOUT_MS,
      signal,
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      const next = appendBounded(chunk, stdout);
      stdout = next.text;
      truncated = truncated || next.truncated;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const next = appendBounded(chunk, stderr);
      stderr = next.text;
      truncated = truncated || next.truncated;
    });

    child.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        resolve({
          stdout: "",
          stderr: "",
          exitCode: null,
          truncated: false,
          missing: true,
        });
        return;
      }
      resolve({ stdout, stderr: stderr + `\n${e.message}`, exitCode: null, truncated });
    });

    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code, truncated });
    });

    if (stdin != null && child.stdin) {
      child.stdin.end(stdin);
    } else {
      child.stdin?.end();
    }
  });
}

function formatResult(args: string[], r: HeyctlResult): string {
  if (r.missing) {
    return (
      "heyctl is not installed on this VM. It ships in the fastcar image at " +
      "/usr/local/bin/heyctl (see deploy/image/Dockerfile); on a dev box, " +
      "build it from heyo-public/app-lb/heyctl and put it on PATH."
    );
  }
  const banner = `heyctl ${args.join(" ")}`;
  const exitLine = r.exitCode == null ? "(no exit code)" : `exit ${r.exitCode}`;
  const truncNote = r.truncated ? "\n…(output truncated — kept the tail)" : "";
  const parts = [banner];
  if (r.stdout.trim()) parts.push(r.stdout.replace(/\s+$/, ""));
  if (r.stderr.trim()) parts.push(`stderr:\n${r.stderr.replace(/\s+$/, "")}`);
  parts.push(exitLine + truncNote);
  return parts.join("\n\n");
}

export const HEYCTL_TOOL_NAMES = ["heyctl"];

/**
 * heyctl subcommands that change deployments, VMs, certificates or secrets.
 * The tool runs every subcommand the same way; this list is the conductor's
 * plan-mode gate — read verbs (get/describe/top/status/whoami/rollout status)
 * stay available, mutating ones are blocked. If the model runs a write via an
 * unlisted subcommand (e.g. a future verb), plan mode does not catch it, so the
 * plan-mode prompt reminds the model to treat anything that changes state as
 * mutating and to ask before running it.
 */
export const HEYCTL_MUTATING_TOOLS = ["heyctl"];
