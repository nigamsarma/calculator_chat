/*
Cloudflare Worker relay for calculator chat.

Required bindings in wrangler.toml:
  [[kv_namespaces]]
  binding = "OFFLINE_KV"
  id = "<your-kv-namespace-id>"

Recommended:
  Use a Durable Object for production coordination/presence. This Worker keeps
  presence in a Durable Object below so multiple Worker isolates do not lose
  the online-user map.

Secrets for Web Push (optional):
  VAPID_PUBLIC_KEY
  VAPID_PRIVATE_KEY
  VAPID_SUBJECT (e.g. mailto:admin@example.com)

The browser must connect to:
  wss://<worker-domain>/ws?user=<user-id>

Important:
  User IDs in this sample are identifiers, not authentication credentials.
  Anyone who knows an ID can impersonate it. For a real deployment, replace
  the auth handshake with authenticated identity (e.g. signed short-lived
  tokens). The relay never sees message plaintext.
*/

const TTL = 604800;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
        }
      });
    }

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "calculator-relay" });
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      const userId = sanitizeId(url.searchParams.get("user"));
      if (!userId) return new Response("Missing user", { status: 400 });

      const id = env.PRESENCE.idFromName("presence");
      const stub = env.PRESENCE.get(id);
      return stub.fetch(new Request("https://presence/ws", {
        headers: request.headers,
        method: "GET"
      }));
    }

    // Browser push subscription registration. The Worker keeps this in KV.
    if (url.pathname === "/push/register" && request.method === "POST") {
      const body = await request.json().catch(() => null);
      const userId = sanitizeId(body?.userId);
      const subscription = body?.subscription;
      if (!userId || !subscription?.endpoint) return Response.json({ error: "invalid" }, { status: 400 });

      await env.OFFLINE_KV.put(
        `push:${userId}`,
        JSON.stringify(subscription),
        { expirationTtl: 2592000 }
      );
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }
};

export class Presence {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sockets = new Map();
  }

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url = new URL(request.url);
    const wsId = crypto.randomUUID();
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    let userId = null;

    server.addEventListener("message", async (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === "auth") {
          const claimed = sanitizeId(msg.userId);
          if (!claimed) return send(server, { type: "error", message: "Invalid user ID" });

          userId = claimed;
          this.sockets.set(userId, server);

          send(server, { type: "ready", userId });

          // Drain offline KV. We send each item and wait for client ACK.
          const list = await listUnread(this.env.OFFLINE_KV, userId);
          const items = [];
          for (const key of list) {
            const value = await this.env.OFFLINE_KV.get(key.name, "json");
            if (value) items.push({ ...value, kvKey: key.name });
          }
          if (items.length) {
            send(server, { type: "offline", items });
          }
          return;
        }

        if (!userId) return send(server, { type: "error", message: "Authenticate first" });

        if (msg.type === "ack") {
          if (typeof msg.messageId === "string") {
            const key = `unread:${userId}:${msg.messageId}`;
            await this.env.OFFLINE_KV.delete(key);
          }
          return;
        }

        if (msg.type === "send") {
          const recipientId = sanitizeId(msg.recipientId);
          const senderId = sanitizeId(msg.senderId);
          if (!recipientId || !senderId || senderId !== userId) {
            return send(server, { type: "error", message: "Invalid sender/recipient" });
          }
          if (!msg.payload || !msg.payload.iv || !msg.payload.ct) {
            return send(server, { type: "error", message: "Invalid encrypted payload" });
          }

          const packet = {
            type: "message",
            messageId: String(msg.messageId || crypto.randomUUID()),
            senderId,
            recipientId,
            payload: msg.payload,
            timestamp: Number(msg.timestamp) || Date.now()
          };

          const recipientSocket = this.sockets.get(recipientId);
          if (recipientSocket && recipientSocket.readyState === 1) {
            send(recipientSocket, packet);
            // Sender gets a transport confirmation; recipient separately ACKs.
            send(server, { type: "delivered", messageId: packet.messageId });
          } else {
            const key = `unread:${recipientId}:${packet.messageId}`;
            await this.env.OFFLINE_KV.put(key, JSON.stringify(packet), { expirationTtl: TTL });

            // Push is generic by design; it contains no message text.
            this.env.PUSH?.send?.(recipientId).catch(() => {});
            await triggerPush(this.env.OFFLINE_KV, recipientId, this.env);
            send(server, { type: "buffered", messageId: packet.messageId });
          }
          return;
        }
      } catch {
        send(server, { type: "error", message: "Malformed message" });
      }
    });

    const cleanup = () => {
      if (userId && this.sockets.get(userId) === server) this.sockets.delete(userId);
    };
    server.addEventListener("close", cleanup);
    server.addEventListener("error", cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }
}

function sanitizeId(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  return /^[A-Za-z0-9_-]{3,80}$/.test(s) ? s : null;
}

function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

async function listUnread(kv, userId) {
  const out = [];
  let cursor;
  do {
    const page = await kv.list({ prefix: `unread:${userId}:`, cursor, limit: 1000 });
    out.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/*
  Web Push:
  Browser push requires a valid PushSubscription plus VAPID signing.
  To keep this Worker self-contained, triggerPush below sends a standards-
  compliant Web Push request when VAPID secrets are present.

  Note: Web Push cryptography is intentionally isolated from chat encryption.
  The notification body is always the generic "System update pending".
*/
async function triggerPush(kv, userId, env) {
  const raw = await kv.get(`push:${userId}`);
  if (!raw) return;
  const subscription = JSON.parse(raw);

  if (!env.VAPID_PRIVATE_KEY || !env.VAPID_PUBLIC_KEY || !env.VAPID_SUBJECT) return;

  try {
    const audience = new URL(subscription.endpoint).origin;
    const token = await createVapidJwt(audience, env.VAPID_SUBJECT, env.VAPID_PRIVATE_KEY);
    const res = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        "TTL": "60",
        "Urgency": "normal",
        "Authorization": `vapid t=${token}, k=${env.VAPID_PUBLIC_KEY}`,
        "Content-Length": "0"
      }
    });
    if (!res.ok) console.log("Push provider returned", res.status);
  } catch (err) {
    console.log("Push error", String(err));
  }
}

// Minimal ES256 JWT signing for VAPID.
// VAPID_PRIVATE_KEY must be base64url-encoded raw P-256 private scalar.
// This routine signs a compact JWT using Web Crypto.
async function createVapidJwt(audience, subject, rawPrivateKeyB64Url) {
  const header = { typ: "JWT", alg: "ES256" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { aud: audience, exp: now + 12 * 60 * 60, sub: subject };
  const b64 = obj => base64url(new TextEncoder().encode(JSON.stringify(obj)));
  const signingInput = `${b64(header)}.${b64(payload)}`;

  // VAPID EC private keys are commonly stored as 32-byte raw scalar.
  // The public key must be supplied separately as VAPID_PUBLIC_KEY.
  const d = base64urlToBytes(rawPrivateKeyB64Url);
  const key = await crypto.subtle.importKey(
    "raw",
    d,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64url(new Uint8Array(sig))}`;
}

function base64url(bytes) {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlToBytes(s) {
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4);
  const raw = atob(normalized);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
