/**
 * AWP scanner — outbound WebSocket client (entrypoint).
 *
 * The HomeLab scanner DIALS OUT to the Cloudflare Worker and holds a persistent
 * WebSocket open. The Worker (via the ScannerHub Durable Object) sends scan
 * requests down that socket; we run Playwright and send the result back. Nothing
 * inbound is ever opened on the HomeLab — Tailscale stays the only ingress, and
 * Cloudflare Workers can't reach Tailscale Funnel anyway, so we invert the link.
 *
 * Protocol (JSON text frames):
 *   Worker → us : { id, type: "search"|"observe", payload }
 *   us → Worker : { id, result }
 *   us → Worker : { type: "ping" }   (app-level keepalive; the DO ignores it)
 *
 * Auth: connects with `Authorization: Bearer <SCAN_TOKEN>`.
 *
 * Env:
 *   SCAN_TOKEN      (required) shared secret; MUST match the Worker's SCAN_TOKEN.
 *   WORKER_WS_URL   (optional) defaults to the deployed Worker's /ws/scanner.
 *   PORT            (optional) local /healthz port (default 8080) for ops checks.
 *   CHROMIUM_PATH   (optional) host Chromium path (see scan.js).
 */

import http from "node:http";
import { WebSocket } from "ws";
import { runSearch, runObserve, warmBrowser, shutdownBrowser } from "./scan.js";

const SCAN_TOKEN = process.env.SCAN_TOKEN ?? "";
const WORKER_WS_URL = process.env.WORKER_WS_URL ?? "wss://awp-api.kihwouih.workers.dev/ws/scanner";
const PORT = Number.parseInt(process.env.PORT ?? "8080", 10) || 8080;

const PING_INTERVAL_MS = 30_000; // app+protocol keepalive
const PONG_TIMEOUT_MS = 10_000; // terminate if no pong in time
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

let ws = null;
let connected = false;
let reconnectDelay = RECONNECT_MIN_MS;
let pingTimer = null;
let pongTimer = null;
let stopping = false;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}
function logError(...args) {
  console.error(new Date().toISOString(), ...args);
}

function clearTimers() {
  if (pingTimer) clearInterval(pingTimer);
  if (pongTimer) clearTimeout(pongTimer);
  pingTimer = null;
  pongTimer = null;
}

function scheduleReconnect() {
  if (stopping) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  log(`[ws] reconnecting in ${Math.round(delay / 1000)}s`);
  setTimeout(connect, delay);
}

function startKeepalive() {
  clearTimers();
  pingTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.ping(); // protocol ping; expect a pong
    } catch {
      /* will surface via close/error */
    }
    // Also send an app-level ping so the DO stays warm even if the platform
    // swallows protocol pings.
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {
      /* ignore */
    }
    if (pongTimer) clearTimeout(pongTimer);
    pongTimer = setTimeout(() => {
      logError("[ws] pong timeout — terminating socket");
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }, PONG_TIMEOUT_MS);
  }, PING_INTERVAL_MS);
}

async function handleRequest(msg) {
  // msg: { id, type, payload }
  let result;
  if (msg.type === "search") {
    result = await runSearch(msg.payload ?? {});
  } else if (msg.type === "observe") {
    result = await runObserve(msg.payload ?? {});
  } else {
    result = { error: "unknown_type" };
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ id: msg.id, result }));
  }
}

function connect() {
  if (stopping) return;
  log(`[ws] connecting to ${WORKER_WS_URL}`);
  ws = new WebSocket(WORKER_WS_URL, {
    headers: { Authorization: `Bearer ${SCAN_TOKEN}` },
  });

  ws.on("open", () => {
    connected = true;
    reconnectDelay = RECONNECT_MIN_MS;
    log("[ws] connected to Worker");
    startKeepalive();
  });

  ws.on("pong", () => {
    if (pongTimer) clearTimeout(pongTimer);
    pongTimer = null;
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return; // not a request
    handleRequest(msg).catch((err) => logError("[ws] request handler error:", err && err.message));
  });

  ws.on("close", (code) => {
    connected = false;
    clearTimers();
    log(`[ws] closed (code=${code})`);
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    connected = false;
    logError("[ws] error:", err && err.message ? err.message : err);
    // 'close' will fire next and schedule the reconnect.
  });
}

// --- Local /healthz for ops checks (curl on the HomeLab) ---
const healthServer = http.createServer((req, res) => {
  if (req.url && req.url.split("?")[0] === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, connected, worker: WORKER_WS_URL }));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

healthServer.listen(PORT, () => {
  log(`[scanner] healthz on :${PORT}`);
  if (!SCAN_TOKEN) {
    logError("[scanner] WARNING: SCAN_TOKEN is empty — the Worker will reject the connection (401). Set SCAN_TOKEN.");
  }
});

warmBrowser();
connect();

// --- Lifecycle ---
process.on("unhandledRejection", (reason) => logError("[scanner] unhandledRejection:", reason));
process.on("uncaughtException", (err) => logError("[scanner] uncaughtException:", err && err.stack ? err.stack : err));

async function shutdown(signal) {
  log(`[scanner] ${signal} received — shutting down`);
  stopping = true;
  clearTimers();
  try {
    if (ws) ws.close(1000, "shutdown");
  } catch {
    /* ignore */
  }
  healthServer.close(() => log("[scanner] healthz server closed"));
  await shutdownBrowser();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
