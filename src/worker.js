// Signaling server for one-way screen sharing.
// Video never passes through here: the Worker serves the pages and each Room
// (a Durable Object) relays WebRTC offers/answers/ICE between host and viewers.
// Nobody is introduced to the host until they've sent the room password.
import { DurableObject } from "cloudflare:workers";

const ROOM_RE = /^[a-z0-9-]{3,32}$/;
const MAX_VIEWERS = 20;
const MAX_SOCKETS = 60; // including connections that haven't authenticated yet
const MAX_FAILS = 5; // wrong passwords allowed per window, per room
const FAIL_WINDOW = 60_000;
const ROOM_TTL = 30 * 24 * 3600_000; // forget rooms whose host hasn't been back in 30 days

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const [first, room, ...rest] = url.pathname.split("/").filter(Boolean);

    if (first === "ws" && ROOM_RE.test(room ?? "") && rest.length === 0) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
    }

    if (first === "w" && ROOM_RE.test(room ?? "") && rest.length === 0) {
      return env.ASSETS.fetch(new Request(new URL("/watch", url)));
    }

    if (url.pathname === "/api/ice") return iceServers(env);

    return env.ASSETS.fetch(request);
  },
};

// STUN is enough for most connections. If TURN_KEY_ID / TURN_KEY_API_TOKEN are
// set (Cloudflare Realtime TURN, free tier), a relay is added for strict networks.
async function iceServers(env) {
  let servers = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    try {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({ ttl: 86400 }),
        },
      );
      if (res.ok) servers = [].concat((await res.json()).iceServers);
    } catch {}
  }
  return Response.json(servers, { headers: { "Cache-Control": "no-store" } });
}

const encoder = new TextEncoder();

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations: 100_000 },
    key,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Keepalive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      server.accept();
      server.close(4008, "This room is full.");
    } else {
      // Every socket starts out pending; the first message must be { type: "auth" }.
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ role: "pending" });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const me = ws.deserializeAttachment();

    if (me.role === "pending") {
      if (msg.type === "auth") await this.auth(ws, msg);
      else ws.close(4000, "Not signed in to the room.");
      return;
    }
    if (msg.type !== "signal") return;

    if (me.role === "host") {
      const viewer = this.sockets("viewer").find((v) => v.deserializeAttachment().id === msg.to);
      viewer?.send(JSON.stringify({ type: "signal", data: msg.data }));
    } else {
      this.toHost({ type: "signal", from: me.id, data: msg.data });
    }
  }

  async auth(ws, msg) {
    const password = String(msg.password ?? "");
    const room = await this.ctx.storage.get("room");

    if (msg.role === "host") {
      // The first host claims the room name with a random per-browser token.
      const token = String(msg.token ?? "");
      if (token.length < 16 || password.length < 4) return ws.close(4000, "Invalid room settings.");
      if (room && !safeEqual(room.token, token)) {
        return ws.close(4001, "That room name is already taken. Pick another one.");
      }
      if (!room || !safeEqual(room.hash, await hashPassword(password, room.salt))) {
        const salt = randomHex(16);
        await this.ctx.storage.put("room", { token, salt, hash: await hashPassword(password, salt) });
        for (const v of this.sockets("viewer")) v.close(4003, "The host changed the password.");
      }
      await this.ctx.storage.deleteAlarm();

      for (const old of this.sockets("host")) old.close(4002, "Sharing moved to another tab.");
      ws.serializeAttachment({ role: "host" });
      ws.send(JSON.stringify({ type: "hello", viewers: this.sockets("viewer").map((v) => v.deserializeAttachment().id) }));
      this.toViewers({ type: "host-online" });
      return;
    }

    if (!room) return ws.close(4004, "This room doesn't exist. Check the link, or ask the host to create it first.");

    const now = Date.now();
    let fails = await this.ctx.storage.get("fails");
    if (!fails || now - fails.since > FAIL_WINDOW) fails = { count: 0, since: now };
    if (fails.count >= MAX_FAILS) return ws.close(4029, "Too many wrong passwords. Wait a minute and try again.");

    if (!safeEqual(room.hash, await hashPassword(password, room.salt))) {
      fails.count++;
      await this.ctx.storage.put("fails", fails);
      return ws.close(4003, "Wrong password.");
    }
    if (this.sockets("viewer").length >= MAX_VIEWERS) return ws.close(4008, "This room is full.");

    const id = crypto.randomUUID().slice(0, 8);
    ws.serializeAttachment({ role: "viewer", id });
    ws.send(JSON.stringify({ type: "hello", id, hostOnline: this.sockets("host").length > 0 }));
    this.toHost({ type: "viewer-joined", id });
  }

  webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {}
    this.left(ws);
  }

  webSocketError(ws) {
    this.left(ws);
  }

  left(ws) {
    const me = ws.deserializeAttachment();
    if (me?.role === "viewer") {
      this.toHost({ type: "viewer-left", id: me.id });
    } else if (me?.role === "host" && this.sockets("host").every((h) => h === ws)) {
      this.toViewers({ type: "host-offline" });
      this.ctx.storage.setAlarm(Date.now() + ROOM_TTL);
    }
  }

  async alarm() {
    if (this.sockets("host").length) return;
    for (const ws of this.ctx.getWebSockets()) ws.close(4004, "This room has expired.");
    await this.ctx.storage.deleteAll();
  }

  sockets(role) {
    return this.ctx
      .getWebSockets()
      .filter((ws) => ws.readyState === WebSocket.OPEN && ws.deserializeAttachment()?.role === role);
  }

  toHost(msg) {
    for (const h of this.sockets("host")) h.send(JSON.stringify(msg));
  }

  toViewers(msg) {
    const text = JSON.stringify(msg);
    for (const v of this.sockets("viewer")) v.send(text);
  }
}
