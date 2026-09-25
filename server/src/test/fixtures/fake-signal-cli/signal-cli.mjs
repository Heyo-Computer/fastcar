#!/usr/bin/env node
// A stand-in for `signal-cli -a <account> jsonRpc`: line-delimited JSON-RPC on
// stdin/stdout, just enough of it for services/signal.ts. Used by
// signal.test.ts, and handy for trying the Signal tools in the UI without a
// linked account (SIGNAL_CLI_PATH=<this file>, see README).
//
// Everything it knows comes from <data-dir>/fake-state.json:
//   { "registered": true,
//     "contacts": [{ "number": "+1…", "uuid": "…", "name": "Alice" }],
//     "groups":   [{ "id": "…", "name": "Ops", "isMember": true, "members": [{ "number": "+1…", "uuid": "…" }] }],
//     "unregistered": ["+1…"] }
// An unregistered account exits at once with signal-cli's own message. A direct
// message to a known contact gets an "echo: …" reply unless it contains
// "[no-reply]"; with "[instant-reply]" the reply is written *before* the send
// response, as when a group member answers while signal-cli is still sending. Every request is appended to <data-dir>/fake-requests.jsonl,
// and the test-only method `fakeInject` pushes an arbitrary envelope.
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dataDir = flag("--data-dir");
const account = flag("-a");
if (!dataDir || !account || !args.includes("jsonRpc")) {
  process.stderr.write("fake signal-cli: expected --data-dir DIR -a ACCOUNT jsonRpc\n");
  process.exit(2);
}

const statePath = path.join(dataDir, "fake-state.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};
if (!state.registered) {
  process.stderr.write(`User ${account} is not registered.\n`);
  process.exit(1);
}
const contacts = state.contacts ?? [];
const groups = state.groups ?? [];
const unregistered = new Set(state.unregistered ?? []);

let last = 0;
/** Signal timestamps identify messages, so never hand out the same one twice. */
const stamp = () => (last = Math.max(Date.now(), last + 1));

const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const notify = (envelope) => write({ jsonrpc: "2.0", method: "receive", params: { envelope, account } });

function contactFor(recipient) {
  return contacts.find((c) => c.number === recipient || c.uuid === recipient);
}

function send(params) {
  const timestamp = stamp();
  if (params.groupId) {
    const group = groups.find((g) => g.id === params.groupId);
    if (!group) throw { code: -1, message: `Invalid group id: ${params.groupId}` };
    const results = (group.members ?? []).map((m) => ({
      recipientAddress: { uuid: m.uuid ?? null, number: m.number ?? null },
      type: unregistered.has(m.number) ? "UNREGISTERED_FAILURE" : "SUCCESS",
    }));
    return { timestamp, results };
  }
  const recipients = [].concat(params.recipient ?? []);
  const results = recipients.map((r) => {
    const c = contactFor(r);
    return {
      recipientAddress: { uuid: c?.uuid ?? null, number: c?.number ?? (r.startsWith("+") ? r : null) },
      type: unregistered.has(r) ? "UNREGISTERED_FAILURE" : "SUCCESS",
    };
  });
  const text = String(params.message ?? "");
  for (const r of recipients) {
    const c = contactFor(r);
    if (!c || unregistered.has(r) || text.includes("[no-reply]")) continue;
    const reply = () => {
      const t = stamp();
      notify({
        source: c.number, sourceNumber: c.number, sourceUuid: c.uuid, sourceName: c.name,
        sourceDevice: 1, timestamp: t,
        dataMessage: { timestamp: t, message: `echo: ${text}`, expiresInSeconds: 0, viewOnce: false },
      });
    };
    if (text.includes("[instant-reply]")) reply();
    else setTimeout(reply, 50);
  }
  return { timestamp, results };
}

function handle(req) {
  switch (req.method) {
    case "send":
      return send(req.params ?? {});
    case "listGroups":
      return groups;
    case "listContacts":
      return contacts;
    case "fakeInject":
      notify(req.params.envelope);
      return {};
    default:
      throw { code: -32601, message: "Method not implemented" };
  }
}

const log = path.join(dataDir, "fake-requests.jsonl");
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    write({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
    return;
  }
  fs.appendFileSync(log, `${line}\n`);
  try {
    write({ jsonrpc: "2.0", result: handle(req), id: req.id });
  } catch (err) {
    write({ jsonrpc: "2.0", error: { code: err.code ?? -1, message: err.message ?? String(err), data: null }, id: req.id });
  }
}).on("close", () => process.exit(0));
