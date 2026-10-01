var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// index.js
import { DurableObject } from "cloudflare:workers";
var ALLOWED_ORIGINS = ["https://nigamsarma.github.io", "https://tap-the-ball.pages.dev", "http://localhost:3000", "http://127.0.0.1:8787", "http://localhost:8787"];
var vapidJwk = {
  kty: "EC",
  crv: "P-256",
  x: "p9FT3qtaagLyAytF-pooeTGWi24O1XSwcvr5xcXOczM",
  y: "AtFIILA2mcEqdrD6bJ4b6oOFrPHBvs4qCkTEV2HHruA",
  d: "PCPbFGXi_7FNNT8nx3dqMb01h47U13KzkZOD6NCCJYI",
  ext: true
};
var PUBLIC_VAPID_KEY = "BKfRU96rWmoC8gMrRfqaKHkxlotuDtV0sHL6-cXFznMzAtFIILA2mcEqdrD6bJ4b6oOFrPHBvs4qCkTEV2HHruA";
function toBase64Url(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
__name(toBase64Url, "toBase64Url");
function bufToBase64Url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
__name(bufToBase64Url, "bufToBase64Url");
async function getVapidAuthHeader(audience) {
  const header = toBase64Url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = toBase64Url(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1e3) + 12 * 60 * 60,
    sub: "mailto:admin@example.com"
  }));
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const key = await crypto.subtle.importKey("jwk", vapidJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sigBuf = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data);
  const jwt = `${header}.${payload}.${bufToBase64Url(sigBuf)}`;
  return `vapid t=${jwt}, k=${PUBLIC_VAPID_KEY}`;
}
__name(getVapidAuthHeader, "getVapidAuthHeader");
var index_default = {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    if (origin && !ALLOWED_ORIGINS.includes(origin) && !origin.startsWith("http://localhost") && !origin.startsWith("http://127.0.0.1")) {
      return new Response("Forbidden", { status: 403 });
    }
    if (request.method === "OPTIONS") return new Response(null, { headers: { "Access-Control-Allow-Origin": origin || "*" } });
    const match = new URL(request.url).pathname.match(/^\/room\/([\w-]{1,64})$/);
    if (!match) return new Response("Not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const stub = env.ROOM.get(env.ROOM.idFromName(match[1]));
    return stub.fetch(request);
  }
};
async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256hex, "sha256hex");
var Room = class extends DurableObject {
  static {
    __name(this, "Room");
  }
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, data TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS subscriptions (endpoint TEXT PRIMARY KEY, sub TEXT NOT NULL)");
  }
  async fetch(request) {
    const token = new URL(request.url).searchParams.get("t") || "";
    if (!/^[0-9a-f]{64}$/.test(token)) return new Response("Bad token", { status: 400 });
    const hash = await sha256hex(token);
    const row = this.sql.exec("SELECT v FROM meta WHERE k = 'auth'").toArray()[0];
    if (!row) this.sql.exec("INSERT INTO meta (k, v) VALUES ('auth', ?)", hash);
    else if (row.v !== hash) return new Response("Forbidden", { status: 403 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }
  sendHistory(ws, before = null) {
    let rows;
    if (before) {
      rows = this.sql.exec("SELECT id, ts, data FROM (SELECT rowid AS r, id, ts, data FROM messages WHERE ts < ? ORDER BY r DESC LIMIT 50) ORDER BY r", before).toArray();
    } else {
      rows = this.sql.exec("SELECT id, ts, data FROM (SELECT rowid AS r, id, ts, data FROM messages ORDER BY r DESC LIMIT 50) ORDER BY r").toArray();
    }
    const meta = this.sql.exec("SELECT k, v FROM meta WHERE k LIKE 'read_%'").toArray();
    const reads = {};
    for (const row of meta) reads[row.k.replace('read_', '')] = parseInt(row.v);
    ws.send(JSON.stringify({ type: "history", messages: rows, isPagination: !!before, reads }));
  }
  async webSocketMessage(ws, message) {
    if (typeof message !== "string" || message.length > 2e4) return;
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (msg.type === "sync") return this.sendHistory(ws, msg.before);
    if (msg.type === "subscribe" && msg.sub && msg.sub.endpoint) {
      const subData = msg.sub;
      if (msg.uid) subData.uid = msg.uid;
      try { ws.serializeAttachment({ uid: msg.uid, endpoint: msg.sub.endpoint, visible: true }); } catch(e) {}
      this.sql.exec("INSERT OR REPLACE INTO subscriptions (endpoint, sub) VALUES (?, ?)", msg.sub.endpoint, JSON.stringify(subData));
      return;
    }
    if (msg.type === "status") {
      try { 
        let att = ws.deserializeAttachment() || {};
        att.visible = msg.visible;
        ws.serializeAttachment(att);
      } catch(e) {}
      return;
    }
    if (msg.type === "read" && msg.uid && msg.maxTs) {
      this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", 'read_' + msg.uid, msg.maxTs.toString());
      const out = JSON.stringify({ type: "read", uid: msg.uid, maxTs: msg.maxTs });
      for (const peer of this.ctx.getWebSockets()) {
        if (peer !== ws) {
          try { peer.send(out); } catch {}
        }
      }
      return;
    }
    if (msg.type === "clear") {
      this.sql.exec("DELETE FROM messages");
      this.sql.exec("DELETE FROM meta WHERE k LIKE 'read_%'");
      const done = JSON.stringify({ type: "cleared" });
      for (const peer of this.ctx.getWebSockets()) {
        try {
          peer.send(done);
        } catch {
        }
      }
      return;
    }
    if (msg.type !== "msg") return;
    if (typeof msg.id !== "string" || msg.id.length > 64) return;
    if (typeof msg.data !== "string" || msg.data.length > 8e3) return;
    const ts = Date.now();
    this.sql.exec("INSERT OR IGNORE INTO messages (id, ts, data) VALUES (?, ?, ?)", msg.id, ts, msg.data);
    const out = JSON.stringify({ type: "msg", id: msg.id, ts, data: msg.data });
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== ws) {
        try {
          peer.send(out);
        } catch {
        }
      }
    }
    let allSubs = [];
    if (msg.target_subs && Array.isArray(msg.target_subs)) {
      allSubs = msg.target_subs;
    }
    
    // Fallback to SQLite if Firebase hasn't populated their token yet
    if (allSubs.length === 0) {
      const subs = this.sql.exec("SELECT sub FROM subscriptions").toArray();
      for (const row of subs) {
        try { allSubs.push(JSON.parse(row.sub)); } catch (e) {}
      }
    }
    
    for (const sub of allSubs) {
      try {
        if (msg.uid && sub.uid === msg.uid) continue;
        if (!msg.uid && msg.endpoint && sub.endpoint === msg.endpoint) continue;
        
        let isOnline = false;
        for (const peer of this.ctx.getWebSockets()) {
          try {
            const session = peer.deserializeAttachment();
            if (session && session.visible !== false && ((sub.uid && session.uid === sub.uid) || (sub.endpoint && session.endpoint === sub.endpoint))) {
              isOnline = true;
              break;
            }
          } catch(e) {}
        }
        
        if (isOnline) {
          console.log("User is online, skipping push to:", sub.endpoint);
          continue;
        }

        const endpointUrl = new URL(sub.endpoint);
        const audience = `${endpointUrl.protocol}//${endpointUrl.host}`;
        const authHeader = await getVapidAuthHeader(audience);
        console.log("Sending push to:", sub.endpoint);
        const res = await fetch(sub.endpoint, {
          method: "POST",
          headers: {
            "Authorization": authHeader,
            "TTL": "86400",
            "Content-Length": "0",
            "Urgency": "high",
            'Topic': 'chat-update'
          }
        });
        const txt = await res.text();
        console.log("Push response:", res.status, txt);
        if (res.status === 410 || res.status === 404) {
          try { this.sql.exec("DELETE FROM subscriptions WHERE endpoint = ?", sub.endpoint); } catch (e) {}
        }
      } catch (e) {
        console.error("Push error:", e);
      }
    }
  }
  webSocketClose(ws) {
    try {
      ws.close(1e3);
    } catch {
    }
  }
  webSocketError(ws) {
    try {
      ws.close(1011);
    } catch {
    }
  }
};
export {
  Room,
  index_default as default
};
//# sourceMappingURL=index.js.map
