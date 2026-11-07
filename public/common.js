export async function getIceServers() {
  try {
    const res = await fetch("/api/ice");
    if (res.ok) return await res.json();
  } catch {}
  return [{ urls: "stun:stun.l.google.com:19302" }];
}

// WebSocket that signs in to the room (`auth`) every time it connects and
// reconnects on network drops. Close codes 4000-4099 come from the server on
// purpose (wrong password, room taken, replaced tab) and are not retried.
export class Signal {
  constructor(path, { auth, onMessage, onDrop, onEnd }) {
    this.url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`;
    Object.assign(this, { auth, onMessage, onDrop, onEnd });
    this.connect();
  }

  connect() {
    const ws = (this.ws = new WebSocket(this.url));
    let ping;
    ws.onopen = () => {
      ping = setInterval(() => ws.readyState === 1 && ws.send("ping"), 25000);
      ws.send(JSON.stringify({ type: "auth", ...this.auth }));
    };
    ws.onmessage = (e) => {
      if (e.data !== "pong") this.onMessage(JSON.parse(e.data));
    };
    ws.onclose = (e) => {
      clearInterval(ping);
      if (this.stopped) return;
      if (e.code >= 4000 && e.code < 4100) return this.onEnd?.(e);
      this.onDrop?.();
      setTimeout(() => this.connect(), 1500);
    };
  }

  send(msg) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  stop() {
    this.stopped = true;
    this.ws.close();
  }
}
