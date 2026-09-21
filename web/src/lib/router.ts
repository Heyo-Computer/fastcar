/**
 * A hash router, in about forty lines.
 *
 * Not react-router: the store already owns every async load and every
 * navigation side effect (selectThread lazily fetches history and artifacts),
 * so a second navigation authority would either sit unused or fight it. The
 * route space is five patterns with no nested layouts and no code splitting.
 *
 * Hash rather than path is also the safer choice operationally — index.ts
 * serves index.html for anything outside /api, /ws, /artifacts/ and /pt/, so a
 * hash route never reaches the server and can never collide with an artifact
 * path or a future entry in deploy/fastcar.json's auth.public_paths.
 */

export type AgentTab = "threads" | "output" | "schedules";
export type InboxFilter = "all" | "unread" | "needs_you";

export type Route =
  | { name: "inbox"; filter: InboxFilter }
  | { name: "agents" }
  | { name: "agent"; agentId: string; tab: AgentTab }
  | { name: "agentNew" }
  | { name: "agentEdit"; agentId: string }
  | { name: "thread"; threadId: string }
  | { name: "schedules" };

const AGENT_TABS: AgentTab[] = ["threads", "output", "schedules"];

function currentHash(): string {
  return typeof location === "undefined" ? "" : location.hash;
}
const FILTERS: InboxFilter[] = ["all", "unread", "needs_you"];

/**
 * `location` is defaulted rather than read directly so the module can be
 * imported outside a browser — the store imports it at module load, and the
 * store's reducers are unit-tested under plain Node.
 */
export function parseHash(hash: string = currentHash()): Route {
  const [path, query] = hash.replace(/^#\/?/, "").split("?");
  const seg = (path ?? "").split("/").filter(Boolean);
  const params = new URLSearchParams(query ?? "");

  if (!seg.length || seg[0] === "inbox") {
    const f = params.get("filter") as InboxFilter | null;
    return { name: "inbox", filter: f && FILTERS.includes(f) ? f : "all" };
  }
  if (seg[0] === "schedules") return { name: "schedules" };
  if (seg[0] === "thread" && seg[1]) return { name: "thread", threadId: seg[1] };
  if (seg[0] === "agent") {
    if (seg[1] === "new") return { name: "agentNew" };
    if (seg[1] && seg[2] === "edit") return { name: "agentEdit", agentId: seg[1] };
    if (seg[1]) {
      const tab = seg[2] as AgentTab | undefined;
      return { name: "agent", agentId: seg[1], tab: tab && AGENT_TABS.includes(tab) ? tab : "threads" };
    }
    return { name: "agents" };
  }
  if (seg[0] === "agents") return { name: "agents" };
  return { name: "inbox", filter: "all" };
}

export function toHash(r: Route): string {
  switch (r.name) {
    case "inbox":
      return r.filter === "all" ? "#/" : `#/inbox?filter=${r.filter}`;
    case "agents":
      return "#/agents";
    case "agent":
      return r.tab === "threads" ? `#/agent/${r.agentId}` : `#/agent/${r.agentId}/${r.tab}`;
    case "agentNew":
      return "#/agent/new";
    case "agentEdit":
      return `#/agent/${r.agentId}/edit`;
    case "thread":
      return `#/thread/${r.threadId}`;
    case "schedules":
      return "#/schedules";
  }
}

/** Navigate. The hashchange listener is what actually updates the store. */
export function navigate(r: Route): void {
  if (typeof location === "undefined") return;
  const next = toHash(r);
  if (location.hash === next) return;
  location.hash = next;
}

export function subscribeRoute(fn: (r: Route) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => fn(parseHash());
  window.addEventListener("hashchange", handler);
  return () => window.removeEventListener("hashchange", handler);
}
