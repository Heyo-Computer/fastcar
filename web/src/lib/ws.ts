import type { ClientMessage, ServerMessage } from "@fastcar/shared";
import { useStore } from "../state/store.ts";

let socket: WebSocket | null = null;
let retryDelay = 500;

export function connect(): void {
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
  useStore.getState().setConnection("connecting");
  socket = new WebSocket(url);

  socket.onopen = () => {
    retryDelay = 500;
    useStore.getState().setConnection("open");
  };
  socket.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data as string) as ServerMessage;
      useStore.getState().handleServer(msg);
    } catch (err) {
      console.error("bad server message", err);
    }
  };
  socket.onclose = () => {
    useStore.getState().setConnection("closed");
    socket = null;
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 10_000);
  };
  socket.onerror = () => socket?.close();
}

export function send(msg: ClientMessage): boolean {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
    return true;
  }
  return false;
}
