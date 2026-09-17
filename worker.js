/*
Cloudflare Worker Relay (100% Free Tier Compatible)
Bindings required in Cloudflare Settings > Variables:
  - KV Namespace Binding: OFFLINE_KV
*/

const TTL = 604800; // 7 days in seconds

// In-memory active socket mapping for single-worker instance routing
const activeSockets = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS preflight
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

    // Accept WebSocket requests on root "/" OR "/ws"
    if (url.pathname === "/" || url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();

      let connectedUserId = null;

      server.addEventListener("message", async (event) => {
        try {
          const msg = JSON.parse(event.data);

          // Authenticate session
          if (msg.type === "auth") {
            const claimed = sanitizeId(msg.userId || url.searchParams.get("user"));
            if (!claimed) return send(server, { type: "error", message: "Invalid user ID" });

            connectedUserId = claimed;
            activeSockets.set(connectedUserId, server);

            send(server, { type: "ready", userId: connectedUserId });

            // Drain offline KV buffer
            const list = await listUnread(env.OFFLINE_KV, connectedUserId);
            const items = [];
            for (const key of list) {
              const value = await env.OFFLINE_KV.get(key.name, "json");
              if (value) items.push({ ...value, kvKey: key.name });
            }
            if (items.length) {
              send(server, { type: "offline", items });
            }
            return;
          }

          if (!connectedUserId) return send(server, { type: "error", message: "Authenticate first" });

          // Handle message deletion confirmation (ACK)
          if (msg.type === "ack") {
            if (typeof msg.messageId === "string") {
              const key = `unread:${connectedUserId}:${msg.messageId}`;
              await env.OFFLINE_KV.delete(key);
            }
            return;
          }

          // Handle outgoing message
          if (msg.type === "send") {
            const recipientId = sanitizeId(msg.recipientId);
            const senderId = sanitizeId(msg.senderId);

            if (!recipientId || !senderId || senderId !== connectedUserId) {
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

            const recipientSocket = activeSockets.get(recipientId);
            
            // Deliver instantly if online, otherwise buffer to Cloudflare KV
            if (recipientSocket && recipientSocket.readyState === 1) {
              send(recipientSocket, packet);
              send(server, { type: "delivered", messageId: packet.messageId });
            } else {
              const key = `unread:${recipientId}:${packet.messageId}`;
              await env.OFFLINE_KV.put(key, JSON.stringify(packet), { expirationTtl: TTL });
              send(server, { type: "buffered", messageId: packet.messageId });
            }
            return;
          }
        } catch (err) {
          send(server, { type: "error", message: "Malformed message" });
        }
      });

      const cleanup = () => {
        if (connectedUserId && activeSockets.get(connectedUserId) === server) {
          activeSockets.delete(connectedUserId);
        }
      };
      server.addEventListener("close", cleanup);
      server.addEventListener("error", cleanup);

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }
};

// Updated regex to safely support emails and normal User IDs
function sanitizeId(value) {
  if (typeof value !== "string") return null;
  const s = value.trim();
  return /^[A-Za-z0-9_@.-]{3,80}$/.test(s) ? s : null;
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
