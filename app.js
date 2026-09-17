/*
  STEALTH CALCULATOR CHAT
  -----------------------
  Configure:
    1) GOOGLE_CLIENT_ID below with your Google OAuth Web Client ID.
    2) WORKER_URL below with your deployed wss:// Cloudflare Worker URL.
    3) The Google Cloud project must enable Drive API and authorize the exact
       origin of this page. Scope used here is ONLY drive.appdata.

  Security model:
    - No localStorage/sessionStorage/IndexedDB/cookies are used.
    - Plaintext messages, passphrases and derived CryptoKeys live only in RAM.
    - Drive history is an encrypted JSON envelope containing encrypted payloads.
    - The relay sees recipient/sender IDs and ciphertext, not plaintext.
    - Client-provided IDs are identifiers, NOT authentication. For hostile
      environments, replace the demo ID handshake with a real authentication
      mechanism before deployment.
*/

(() => {
  "use strict";

  const CONFIG = Object.freeze({
    GOOGLE_CLIENT_ID: "551221372606-r2hjsvubg2i06g01i89fcleb9rlrndge.apps.googleusercontent.com",
    WORKER_URL: "wss://stealth-relay.snigamanandhasarma.workers.dev/",
    PBKDF2_ITERATIONS: 150000,
    DRIVE_SCOPE: "https://www.googleapis.com/auth/drive.appdata",
    HISTORY_PREFIX: "chat_"
  });

  const $ = (id) => document.getElementById(id);
  const volatile = {
    secretMode: false,
    userId: null,
    contactId: null,
    contactLabel: null,
    passphrase: null,
    key: null,
    salt: null,
    ws: null,
    driveToken: null,
    driveTokenExpiresAt: 0,
    gisCodeClient: null,
    contacts: [],
    history: [],
    calc: "",
    escapeTimer: null,
    ackWaiters: new Map(),
    pushRegistration: null
  };

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove("show"), 1800);
  }

  function wipeString(name) {
    if (typeof volatile[name] === "string") volatile[name] = "";
    volatile[name] = null;
  }

  function hardPanic() {
    try {
      if (volatile.ws) volatile.ws.close();
    } catch {}
    volatile.ws = null;
    volatile.history.length = 0;
    volatile.contacts.length = 0;
    volatile.ackWaiters.clear();
    volatile.key = null;
    volatile.salt = null;
    volatile.driveToken = null;
    volatile.driveTokenExpiresAt = 0;
    wipeString("passphrase");
    wipeString("userId");
    wipeString("contactId");
    wipeString("contactLabel");
    volatile.calc = "";
    document.documentElement.replaceChildren();
    location.replace("https://google.com");
  }

  // Escape twice rapidly OR Ctrl+Shift+Q.
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "q") {
      e.preventDefault();
      hardPanic();
      return;
    }
    if (e.key === "Escape") {
      const now = performance.now();
      if (volatile.escapeTimer && now - volatile.escapeTimer < 450) {
        e.preventDefault();
        hardPanic();
      }
      volatile.escapeTimer = now;
    }
  }, { capture: true });

  // ---------- Calculator ----------
  function renderCalc() {
    $("calcDisplay").value = volatile.calc || "0";
  }

  function appendCalc(v) {
    volatile.calc += v;
    renderCalc();
  }

  function safeCalculate(expression) {
    let x = expression
      .replaceAll("×", "*")
      .replaceAll("÷", "/")
      .replaceAll("π", "Math.PI")
      .replaceAll("^", "**")
      .replace(/\bsqrt\(/g, "Math.sqrt(")
      .replace(/\bsin\(/g, "Math.sin(")
      .replace(/\bcos\(/g, "Math.cos(")
      .replace(/\btan\(/g, "Math.tan(")
      .replace(/\blog\(/g, "Math.log10(")
      .replace(/\bln\(/g, "Math.log(");

    // Only permit the generated calculator grammar.
    if (!/^[0-9+\-*/().,\sA-Za-z_]*$/.test(x)) throw new Error("Invalid expression");
    if (/(?:constructor|prototype|__proto__|Function|eval|window|document)/i.test(x)) {
      throw new Error("Invalid expression");
    }
    const result = Function(`"use strict"; return (${x})`)();
    if (!Number.isFinite(result)) throw new Error("Math error");
    return String(Math.round(result * 1e12) / 1e12);
  }

  $("calcKeys").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.dataset.action === "clear") {
      volatile.calc = "";
      $("calcExpression").textContent = "";
      renderCalc();
    } else if (btn.dataset.action === "backspace") {
      volatile.calc = volatile.calc.slice(0, -1);
      renderCalc();
    } else if (btn.dataset.action === "equals") {
      try {
        const old = volatile.calc;
        const result = safeCalculate(old);
        $("calcExpression").textContent = old;
        volatile.calc = result;
        renderCalc();
      } catch {
        $("calcExpression").textContent = "Error";
        volatile.calc = "";
        renderCalc();
      }
    } else if (btn.dataset.value) {
      appendCalc(btn.dataset.value);
    }
  });

  // Secret sequence: 1337=
  let secretSequence = "";
  window.addEventListener("keydown", (e) => {
    if (volatile.secretMode) return;
    if (/^[0-9=]$/.test(e.key)) {
      secretSequence = (secretSequence + e.key).slice(-5);
      if (secretSequence === "1337=") {
        secretSequence = "";
        enterSecretMode();
      }
    } else if (!e.ctrlKey && !e.altKey && !e.metaKey) {
      secretSequence = "";
    }
  });

  $("titleBar").addEventListener("dblclick", enterSecretMode);

  function enterSecretMode() {
    volatile.secretMode = true;
    $("calculatorView").classList.add("hidden");
    $("calculatorView").setAttribute("aria-hidden", "true");
    $("chatView").classList.remove("hidden");
    $("chatView").setAttribute("aria-hidden", "false");
    renderContacts();
    toast("Secure workspace");
  }

  function lockToCalculator() {
    try { volatile.ws?.close(); } catch {}
    volatile.ws = null;
    volatile.history.length = 0;
    volatile.key = null;
    volatile.salt = null;
    wipeString("passphrase");
    volatile.contactId = null;
    volatile.contactLabel = null;
    volatile.secretMode = false;
    $("messages").replaceChildren();
    $("chatView").classList.add("hidden");
    $("chatView").setAttribute("aria-hidden", "true");
    $("calculatorView").classList.remove("hidden");
    $("calculatorView").setAttribute("aria-hidden", "false");
  }

  $("lockBtn").addEventListener("click", lockToCalculator);
  $("panicBtn").addEventListener("click", hardPanic);

  // ---------- Web Crypto ----------
  function randomBytes(n) {
    const b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b;
  }

  function bytesToB64(bytes) {
    let s = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  function b64ToBytes(s) {
    const raw = atob(s);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function deriveKey(passphrase, salt) {
    const material = await crypto.subtle.importKey(
      "raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: CONFIG.PBKDF2_ITERATIONS, hash: "SHA-256" },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function encryptText(text) {
    const iv = randomBytes(12);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      volatile.key,
      enc.encode(text)
    );
    return { v: 1, alg: "A256GCM", iv: bytesToB64(iv), ct: bytesToB64(new Uint8Array(ciphertext)) };
  }

  async function decryptText(envelope) {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64ToBytes(envelope.iv) },
      volatile.key,
      b64ToBytes(envelope.ct)
    );
    return dec.decode(plain);
  }

  // ---------- Contacts / setup ----------
  $("addContactBtn").addEventListener("click", () => {
    $("setupTitle").textContent = "Open secure file";
    $("userIdInput").value = volatile.userId || "";
    $("contactIdInput").value = "";
    $("passphraseInput").value = "";
    $("setupDialog").showModal();
  });

  $("setupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const userId = $("userIdInput").value.trim();
    const contactId = $("contactIdInput").value.trim();
    const passphrase = $("passphraseInput").value;
    if (!userId || !contactId || passphrase.length < 12) {
      toast("Use IDs and a 12+ character passphrase");
      return;
    }

    volatile.userId = userId;
    volatile.contactId = contactId;
    volatile.contactLabel = fakeLabel(contactId);
    volatile.passphrase = passphrase;
    volatile.salt = await saltForContact(contactId);
    volatile.key = await deriveKey(passphrase, volatile.salt);

    $("setupDialog").close();
    $("identityLabel").textContent = `ID: ${userId}`;
    renderContacts();
    await openContact();
    await connectRelay();
    await loadHistory();
    renderMessages();

    // Best effort: Google login is optional; no browser storage is used.
    initGoogle();
  });

  function fakeLabel(id) {
    const labels = ["Budget_2026.csv", "Draft_Notes", "Q3_Review.xlsx", "Archive_17.txt", "Meeting_Log.docx"];
    let n = 0;
    for (const c of id) n = (n * 31 + c.charCodeAt(0)) >>> 0;
    return labels[n % labels.length];
  }

  async function saltForContact(contactId) {
    const digest = await crypto.subtle.digest("SHA-256", enc.encode(`calculator-chat:${contactId}`));
    return new Uint8Array(digest).slice(0, 16);
  }

  function renderContacts() {
    const list = $("contactList");
    list.replaceChildren();
    for (const c of volatile.contacts) {
      const b = document.createElement("button");
      b.className = `contact ${c.id === volatile.contactId ? "active" : ""}`;
      b.innerHTML = `<span>${escapeHtml(c.label)}</span><small>Last opened locally</small>`;
      b.addEventListener("click", () => switchContact(c.id));
      list.appendChild(b);
    }
    if (!volatile.contacts.length && volatile.contactId) {
      volatile.contacts.push({ id: volatile.contactId, label: volatile.contactLabel });
      renderContacts();
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }

  async function switchContact(id) {
    const current = volatile.contactId;
    if (current === id) return;
    try { volatile.ws?.close(); } catch {}
    volatile.ws = null;
    volatile.contactId = id;
    volatile.contactLabel = fakeLabel(id);
    volatile.history.length = 0;
    volatile.salt = await saltForContact(id);
    volatile.key = await deriveKey(volatile.passphrase, volatile.salt);
    renderContacts();
    await connectRelay();
    await loadHistory();
    renderMessages();
  }

  async function openContact() {
    if (!volatile.contacts.some(c => c.id === volatile.contactId)) {
      volatile.contacts.push({ id: volatile.contactId, label: volatile.contactLabel });
    }
    $("contactTitle").textContent = volatile.contactLabel;
    renderContacts();
  }

  // ---------- Cloudflare WebSocket relay ----------
  async function connectRelay() {
  if (!volatile.userId) return;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${CONFIG.RELAY_URL.replace(/^http/, "ws")}/?user=${encodeURIComponent(volatile.userId)}`;

  if (volatile.ws) {
    volatile.ws.close();
  }

  const ws = new WebSocket(wsUrl);
  volatile.ws = ws;

  ws.addEventListener("open", () => {
    $("connectionState").textContent = "Connected";
    ws.send(JSON.stringify({ type: "auth", userId: volatile.userId }));

    // Heartbeat ping every 30 seconds to prevent idle timeout
    if (volatile.pingInterval) clearInterval(volatile.pingInterval);
    volatile.pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "auth", userId: volatile.userId }));
      }
    }, 30000);
  });

  ws.addEventListener("message", async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "offline" && Array.isArray(data.items)) {
        for (const item of data.items) {
          await handleIncomingPacket(item);
          ws.send(JSON.stringify({ type: "ack", messageId: item.messageId }));
        }
      }
      if (data.type === "message") {
        await handleIncomingPacket(data);
        ws.send(JSON.stringify({ type: "ack", messageId: data.messageId }));
      }
    } catch (e) {
      console.error("Message parse error:", e);
    }
  });

  ws.addEventListener("close", () => {
    $("connectionState").textContent = "Reconnecting...";
    if (volatile.pingInterval) clearInterval(volatile.pingInterval);
    
    // Auto-reconnect after 3 seconds if disconnected by Cloudflare
    setTimeout(() => {
      if (volatile.userId) connectRelay();
    }, 3000);
  });

  ws.addEventListener("error", () => {
    ws.close();
  });
}

  async function handleIncomingPacket(packet) {
  if (!packet || packet.senderId !== volatile.contactId) return;

  // Prevent duplicate rendering if message is already in memory
  if (volatile.history.some(m => m.id === packet.messageId)) return;

  const text = await decryptText(packet.payload);
  if (!text) return;

  const msgObj = {
    id: packet.messageId,
    senderId: packet.senderId,
    recipientId: packet.recipientId,
    timestamp: packet.timestamp || Date.now(),
    text
  };

  volatile.history.push(msgObj);
  renderMessage(msgObj);
  saveHistory();
}
  async function receiveRelayMessage(msg) {
    if (msg.recipientId && msg.recipientId !== volatile.userId) return;
    try {
      const text = await decryptText(msg.payload);
      const item = {
        id: msg.messageId || crypto.randomUUID(),
        senderId: msg.senderId,
        recipientId: volatile.userId,
        timestamp: msg.timestamp || Date.now(),
        text,
        mine: false
      };
      volatile.history.push(item);
      renderMessages();
      await saveHistory();
      if (volatile.ws?.readyState === WebSocket.OPEN && msg.messageId) {
        volatile.ws.send(JSON.stringify({ type: "ack", messageId: msg.messageId }));
      }
    } catch {
      toast("Unable to decrypt incoming message");
    }
  }

  $("messageForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("messageInput");
    const text = input.value.trim();
    if (!text || !volatile.key || !volatile.ws || volatile.ws.readyState !== WebSocket.OPEN) return;

    const messageId = crypto.randomUUID();
    const timestamp = Date.now();
    const payload = await encryptText(text);
    const item = {
      id: messageId,
      senderId: volatile.userId,
      recipientId: volatile.contactId,
      timestamp,
      text,
      mine: true
    };
    volatile.history.push(item);
    renderMessages();
    input.value = "";

    volatile.ws.send(JSON.stringify({
      type: "send",
      messageId,
      senderId: volatile.userId,
      recipientId: volatile.contactId,
      timestamp,
      payload
    }));
    await saveHistory();
  });

  function renderMessages() {
    const box = $("messages");
    box.replaceChildren();
    for (const m of volatile.history) {
      const row = document.createElement("div");
      row.className = `message ${m.mine ? "mine" : ""}`;
      const body = document.createElement("div");
      body.textContent = m.text;
      const meta = document.createElement("div");
      meta.className = "message-meta";
      meta.textContent = new Date(m.timestamp).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
      row.append(body, meta);
      box.appendChild(row);
    }
    box.scrollTop = box.scrollHeight;
    $("messageInput").disabled = !volatile.key || !volatile.ws || volatile.ws.readyState !== WebSocket.OPEN;
    $("sendBtn").disabled = $("messageInput").disabled;
  }

  // ---------- Google Drive appDataFolder ----------
  // GIS token client is intentionally kept in RAM. The restricted drive.appdata
  // scope limits access to this app's hidden application data.
  function initGoogle() {
    if (!window.google?.accounts?.oauth2) return;
    if (CONFIG.GOOGLE_CLIENT_ID.startsWith("REPLACE_")) {
      $("driveBtn").textContent = "Sign in";
      return;
    }
    if (!volatile.gisCodeClient) {
      volatile.gisCodeClient = google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.GOOGLE_CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/drive.appdata',
        callback: (response) => {
          if (response.error) {
            toast("Google authorization failed");
            return;
          }
          volatile.driveToken = response.access_token;
          volatile.driveTokenExpiresAt = Date.now() + ((response.expires_in || 3600) * 1000) - 60000;
          $("driveBtn").textContent = "Drive ✓";
          loadHistory().catch(() => toast("Drive history unavailable"));
        }
      });
    }
  }

  $("driveBtn").addEventListener("click", () => {
    if (!window.google?.accounts?.oauth2 || CONFIG.GOOGLE_CLIENT_ID.startsWith("REPLACE_")) {
      toast("Configure Google Client ID first");
      return;
    }
    initGoogle();
    volatile.gisCodeClient.requestAccessToken({ prompt: volatile.driveToken ? "" : "consent" });
  });

  async function ensureDriveToken() {
    if (volatile.driveToken && Date.now() < volatile.driveTokenExpiresAt) return volatile.driveToken;
    if (!volatile.gisCodeClient) return null;
    return new Promise((resolve) => {
      const old = volatile.gisCodeClient.callback;
      volatile.gisCodeClient.callback = (r) => {
        volatile.gisCodeClient.callback = old;
        if (r.error) return resolve(null);
        volatile.driveToken = r.access_token;
        volatile.driveTokenExpiresAt = Date.now() + ((r.expires_in || 3600) * 1000) - 60000;
        resolve(r.access_token);
      };
      volatile.gisCodeClient.requestAccessToken({ prompt: "" });
    });
  }

  async function driveFetch(path, options = {}) {
    const token = await ensureDriveToken();
    if (!token) throw new Error("Drive not authorized");
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${token}`);
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const res = await fetch(`https://www.googleapis.com/drive/v3${path}`, { ...options, headers });
    if (!res.ok) throw new Error(`Drive HTTP ${res.status}`);
    return res;
  }

  async function findHistoryFile() {
    const q = encodeURIComponent(`name='${CONFIG.HISTORY_PREFIX}${volatile.contactId}.json' and 'appDataFolder' in parents and trashed=false`);
    const res = await driveFetch(`/files?spaces=appDataFolder&q=${q}&fields=files(id,name)&pageSize=10`);
    const data = await res.json();
    return data.files?.[0] || null;
  }

  async function loadHistory() {
    const file = await findHistoryFile().catch(() => null);
    if (!file) return;
    const res = await driveFetch(`/files/${encodeURIComponent(file.id)}?alt=media`);
    const envelope = await res.json();
    if (!envelope?.records) return;
    const decrypted = [];
    for (const r of envelope.records) {
      try {
        const text = await decryptText(r.payload);
        decrypted.push({
          id: r.id, senderId: r.senderId, recipientId: r.recipientId,
          timestamp: r.timestamp, text, mine: r.senderId === volatile.userId
        });
      } catch {
        // A bad/corrupt record is ignored rather than displayed.
      }
    }
    volatile.history = decrypted;
    renderMessages();
  }

  async function saveHistory() {
    if (!volatile.driveToken || !volatile.contactId || !volatile.key) return;
    const records = [];
    for (const m of volatile.history.slice(-500)) {
      records.push({
        id: m.id, senderId: m.senderId, recipientId: m.recipientId,
        timestamp: m.timestamp, payload: await encryptText(m.text)
      });
    }
    const envelope = {
      version: 1,
      contactId: volatile.contactId,
      updatedAt: Date.now(),
      records
    };
    const existing = await findHistoryFile().catch(() => null);
    const body = JSON.stringify(envelope);
    const token = await ensureDriveToken();
    if (!token) return;

    if (!existing) {
      const boundary = `----calculator-chat-${crypto.randomUUID()}`;
      const meta = JSON.stringify({
        name: `${CONFIG.HISTORY_PREFIX}${volatile.contactId}.json`,
        parents: ["appDataFolder"],
        mimeType: "application/json"
      });
      const multipart = [
        `--${boundary}`, "Content-Type: application/json; charset=UTF-8", "", meta,
        `--${boundary}`, "Content-Type: application/json", "", body,
        `--${boundary}--`
      ].join("\r\n");

      // Uses the mandatory /upload/ endpoint path for Drive uploads
      await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`
        },
        body: multipart
      });
    } else {
      await fetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existing.id)}?uploadType=media`, {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body
      });
    }
  }

  // Best-effort Google initialization after GIS script has loaded.
  window.addEventListener("load", () => setTimeout(initGoogle, 300));

  // ---------- Optional generic Web Push registration ----------
  // The Worker stores only the browser's push subscription object. Actual push
  // delivery requires VAPID keys configured as Worker secrets.
  async function registerPush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    try {
      const registration = await navigator.serviceWorker.register("sw.js");
      volatile.pushRegistration = registration;
    } catch {}
  }
  registerPush();

  // Keep secret UI inert until explicitly unlocked.
  renderCalc();
})();
