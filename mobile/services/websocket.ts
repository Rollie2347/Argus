import Constants from "expo-constants";

const RAW_BACKEND = process.env.EXPO_PUBLIC_BACKEND_URL;
if (!RAW_BACKEND) {
  throw new Error("EXPO_PUBLIC_BACKEND_URL is not set — configure mobile/.env before running the app (see mobile/.env.example).");
}
export const BACKEND = RAW_BACKEND;
const WS_URL = BACKEND.replace("https://","wss://").replace("http://","ws://") + "/ws";
const WS_SECRET = process.env.EXPO_PUBLIC_WS_SHARED_SECRET || "";

// The binary this session is running, reported on connect purely so the
// question "which build was that report against?" is answerable from the
// server logs. This repo has answered it wrong at least five times — #39's
// correction cost a whole session debugging a fix the device never had, and
// the same class of mistake produced #53's and #58's stale build claims. The
// client is the only thing that knows, and it was never saying.
//
// Constants.platform.ios.buildNumber is the embedded Info.plist
// CFBundleVersion: baked into the binary at build time and, unlike
// expoConfig.ios.buildNumber, not something a manifest can restate. It is
// null under Expo Go, which is itself the useful answer there.
const NATIVE_BUILD =
  (Constants.platform as any)?.ios?.buildNumber ??
  (Constants.platform as any)?.android?.versionCode ??
  null;
const APP_BUILD = `${Constants.expoConfig?.version ?? "?"} (${NATIVE_BUILD ?? "expo-go"})`;

export type MsgHandler = (msg: any) => void;

// Every dispatched message carries the `epoch` this socket was created with.
// close() is asynchronous and nulling a reference does NOT detach the
// onmessage/onclose handlers from the underlying WebSocket — so a socket the
// app has already moved on from could still fire into the shared handler and
// tear down a newer session (camera dropping back to the dormant screen
// mid-conversation) or push its leftover audio into the playback queue on top
// of the live session's audio. The epoch lets the receiver drop anything that
// didn't come from the session it currently owns.
export class ArgusSocket {
  private ws: WebSocket | null = null;
  private onMsg: MsgHandler;
  private userId: string;
  private userName: string;
  private epoch: number;
  private greetTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(onMsg: MsgHandler, userId: string, userName: string, epoch: number) {
    this.onMsg = onMsg; this.userId = userId; this.userName = userName; this.epoch = epoch;
  }

  private emit(msg: any) { this.onMsg({ ...msg, epoch: this.epoch }); }

  // Drops every handler and pending timer so this socket can never call back
  // into the app again, regardless of what the OS does with the connection
  // afterwards.
  private detach() {
    if (this.greetTimer) { clearTimeout(this.greetTimer); this.greetTimer = null; }
    const ws = this.ws;
    if (ws) { ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null; }
  }

  connect() {
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    ws.onopen = () => {
      if (this.closed) return;
      try { ws.send(JSON.stringify({ type: "user_id", id: this.userId, name: this.userName, secret: WS_SECRET, build: APP_BUILD })); } catch {}
      this.greetTimer = setTimeout(() => {
        if (this.closed || ws.readyState !== WebSocket.OPEN) return;
        try { ws.send(JSON.stringify({ type: "greet" })); } catch {}
      }, 1200);
    };
    ws.onmessage = (e) => {
      if (this.closed) return;
      try { this.emit(JSON.parse(e.data)); } catch {}
    };
    ws.onerror = () => {
      if (this.closed) return;
      this.emit({ type: "error", data: "Connection error" });
    };
    ws.onclose = (e: any) => {
      if (this.closed) return;
      this.detach();
      // code/reason let the UI distinguish a genuine backend-side drop from a
      // normal teardown instead of silently reverting to the dormant screen.
      this.emit({ type: "disconnected", code: e?.code, reason: e?.reason });
    };
  }

  // A caller-initiated disconnect is deliberately silent — the caller already
  // knows it is tearing down, and emitting "disconnected" here would race the
  // next session's setup.
  disconnect() {
    if (this.closed) return;
    this.closed = true;
    const ws = this.ws;
    this.detach();
    this.ws = null;
    if (ws) { try { ws.close(); } catch {} }
  }

  private send(payload: object) {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) return;
    try { this.ws.send(JSON.stringify(payload)); } catch {}
  }

  // `gated` says Argus's audio was playing out of the speaker when this chunk
  // was captured, so the server can tell his voice from the user's without
  // guessing. Older servers ignore the extra field; the flag is advisory and
  // the server's own responseInFlight is what actually gates.
  sendAudio(b64: string, gated = false) { this.send({ type: "audio", data: b64, gated }); }
  sendImage(b64: string) { this.send({ type: "image", data: b64 }); }
  // Diagnostics only — an event name and a short detail string, never audio,
  // image or transcript content. Older servers ignore the unknown type.
  sendClientLog(event: string, detail?: string) { this.send({ type: "client_log", event, detail }); }
  get ready() { return !this.closed && this.ws?.readyState === WebSocket.OPEN; }
}
