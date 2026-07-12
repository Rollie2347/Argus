const RAW_BACKEND = process.env.EXPO_PUBLIC_BACKEND_URL;
if (!RAW_BACKEND) {
  throw new Error("EXPO_PUBLIC_BACKEND_URL is not set — configure mobile/.env before running the app (see mobile/.env.example).");
}
export const BACKEND = RAW_BACKEND;
const WS_URL = BACKEND.replace("https://","wss://").replace("http://","ws://") + "/ws";
const WS_SECRET = process.env.EXPO_PUBLIC_WS_SHARED_SECRET || "";

export type MsgHandler = (msg: any) => void;

export class ArgusSocket {
  private ws: WebSocket | null = null;
  private onMsg: MsgHandler;
  private userId: string;
  private userName: string;

  constructor(onMsg: MsgHandler, userId: string, userName: string) {
    this.onMsg = onMsg; this.userId = userId; this.userName = userName;
  }

  connect() {
    this.ws = new WebSocket(WS_URL);
    this.ws.onopen = () => {
      this.ws?.send(JSON.stringify({ type: "user_id", id: this.userId, name: this.userName, secret: WS_SECRET }));
      setTimeout(() => this.ws?.send(JSON.stringify({ type: "greet" })), 1200);
    };
    this.ws.onmessage = (e) => { try { this.onMsg(JSON.parse(e.data)); } catch {} };
    this.ws.onerror = () => this.onMsg({ type: "error", data: "Connection error" });
    this.ws.onclose = () => this.onMsg({ type: "disconnected" });
  }

  sendAudio(b64: string) { this.ws?.send(JSON.stringify({ type: "audio", data: b64 })); }
  sendImage(b64: string) { this.ws?.send(JSON.stringify({ type: "image", data: b64 })); }
  disconnect() { this.ws?.close(); this.ws = null; }
  get ready() { return this.ws?.readyState === WebSocket.OPEN; }
}
