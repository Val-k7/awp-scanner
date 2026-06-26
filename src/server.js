/**
 * AWP scanner — a thin, standalone Playwright service.
 *
 * It runs a REAL headless Chromium on a free Oracle Always Free VM and is called
 * by the AWP Cloudflare Worker (over a Cloudflare Tunnel) to read PUBLIC Amazon
 * pages. A real browser executes the page JS, so it passes Amazon's anti-bot
 * wall where a plain HTTP fetch would only get the challenge page.
 *
 * It is deliberately "thin": it returns RAW signals (button/availability text,
 * the displayed price, search-result asins) — NO detection/business logic. The
 * Worker keeps all of that. No Amazon login, no cookies, no captcha bypass: just
 * a real browser + standard desktop headers.
 *
 * HTTP contract (the Worker depends on this exactly):
 *   GET  /healthz                         -> 200 { ok: true }                 (no auth)
 *   POST /search  { marketplace, query, max }
 *                 -> 200 { items: SearchItem[] }                              (auth)
 *   POST /observe { url, marketplace }
 *                 -> 200 { textSignals, priceText, requiresSession }          (auth)
 *   Auth: header `Authorization: Bearer <SCAN_TOKEN>`; missing/wrong -> 401.
 *
 * On any internal error it returns a SAFE empty result with 200 and logs — it
 * never 500-crashes the process.
 *
 * Env: SCAN_TOKEN (required for auth), PORT (default 8080).
 */

import http from "node:http";
import { chromium } from "playwright";
import {
  hostFor,
  acceptLanguageFor,
  parsePriceCents,
  USER_AGENT,
  SIGNAL_PHRASES,
  SESSION_WALL_URL_FRAGMENTS,
  SESSION_WALL_TEXT_FRAGMENTS,
} from "./parse.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10) || 8080;
const SCAN_TOKEN = process.env.SCAN_TOKEN ?? "";

const NAV_TIMEOUT_MS = 20_000; // goto timeout
const SEARCH_WAIT_MS = 10_000; // wait for the results grid
const SEARCH_NAV_RETRIES = 3; // re-navigate if zero results render
const MAX_BODY_BYTES = 64 * 1024; // request body size limit
const RECYCLE_EVERY = 80; // close+relaunch the browser after this many requests

// Safe fallbacks returned on any failure (never throw out of a handler).
const EMPTY_SEARCH = { items: [] };
const EMPTY_OBSERVE = { textSignals: [], priceText: null, requiresSession: true };

// ---------------------------------------------------------------------------
// Shared browser (one Chromium, reused across requests, recycled periodically)
// ---------------------------------------------------------------------------

/** @type {import('playwright').Browser | null} */
let browser = null;
let requestsSinceLaunch = 0;
/** Single-flight guard so concurrent requests don't launch/recycle in parallel. */
let browserLock = Promise.resolve();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}
function logError(...args) {
  console.error(new Date().toISOString(), ...args);
}

async function launchBrowser() {
  // CHROMIUM_PATH lets the host provide its own Chromium (e.g. NixOS, where the
  // Playwright-bundled browser won't run — point this at `${pkgs.chromium}/bin/chromium`).
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  log(`[browser] launching chromium…${executablePath ? ` (executablePath=${executablePath})` : ""}`);
  const b = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", // avoid /dev/shm exhaustion on small VMs
      "--disable-gpu",
    ],
  });
  log("[browser] launched");
  return b;
}

/** Ensure a live browser exists, recycling it every RECYCLE_EVERY requests. */
async function getBrowser() {
  // Serialize launch/recycle decisions through the lock.
  browserLock = browserLock.then(async () => {
    if (browser && requestsSinceLaunch >= RECYCLE_EVERY) {
      log(`[browser] recycling after ${requestsSinceLaunch} requests`);
      const old = browser;
      browser = null;
      requestsSinceLaunch = 0;
      await old.close().catch(() => {});
    }
    if (!browser || !browser.isConnected()) {
      browser = await launchBrowser();
      requestsSinceLaunch = 0;
    }
  });
  await browserLock;
  return browser;
}

/**
 * Open a fresh, asset-light page in a throwaway context with the right locale
 * headers, run `fn`, and always clean up. `fn` gets the Playwright Page.
 */
async function withPage(marketplace, fn) {
  const b = await getBrowser();
  requestsSinceLaunch++;
  const context = await b.newContext({
    userAgent: USER_AGENT,
    locale: (acceptLanguageFor(marketplace).split(",")[0] || "fr-FR"),
    extraHTTPHeaders: { "Accept-Language": acceptLanguageFor(marketplace) },
    viewport: { width: 1366, height: 768 },
  });
  try {
    const page = await context.newPage();
    // Block images / stylesheets / fonts / media — the data we need (text,
    // prices, asins) is all in the HTML/DOM, and this is much faster + lighter.
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "stylesheet" || type === "font" || type === "media") {
        route.abort().catch(() => {});
      } else {
        route.continue().catch(() => {});
      }
    });
    page.setDefaultTimeout(NAV_TIMEOUT_MS);
    return await fn(page);
  } finally {
    await context.close().catch(() => {});
  }
}

/** Click Amazon's cookie-consent button if present; ignore if absent. */
async function dismissConsent(page) {
  try {
    await page.click("#sp-cc-accept", { timeout: 2_000 });
  } catch {
    // No consent banner — proceed.
  }
}

// ---------------------------------------------------------------------------
// In-page extractors (serialized into the page via page.evaluate)
// ---------------------------------------------------------------------------

/**
 * Runs in the page context. Returns each search result's asin/title/href/price.
 * Pure DOM — no closure over server scope (must be self-contained).
 */
function scrapeSearchResultsInPage() {
  const out = [];
  const nodes = document.querySelectorAll(
    'div[data-component-type="s-search-result"][data-asin], div.s-result-item[data-asin]',
  );
  for (const node of nodes) {
    const asin = String(node.getAttribute("data-asin") || "").trim();
    if (!asin) continue;
    const titleEl =
      node.querySelector("h2 a span") ||
      node.querySelector("h2 span") ||
      node.querySelector("h2 a");
    const title = String(titleEl ? titleEl.textContent : "").trim();
    const priceEl = node.querySelector(".a-price .a-offscreen");
    const priceText = priceEl ? String(priceEl.textContent).trim() : null;
    out.push({ asin, title, priceText });
  }
  return out;
}

/**
 * Runs in the page context. Reads the buy/availability signals, the displayed
 * price, and detects a robot/captcha/sign-in wall. The phrase/wall lists are
 * passed in as a single arg (Playwright's page.evaluate passes ONE argument) so
 * the function can't close over server scope.
 */
function scrapeObserveInPage({ phrases, urlWalls, textWalls }) {
  const text = String((document.body && document.body.innerText) || "").toLowerCase();
  const url = String(location.href || "").toLowerCase();

  let requiresSession = false;
  for (const frag of urlWalls) {
    if (url.includes(frag)) {
      requiresSession = true;
      break;
    }
  }
  if (!requiresSession) {
    for (const frag of textWalls) {
      if (text.includes(frag)) {
        requiresSession = true;
        break;
      }
    }
  }

  const signals = [];
  for (const p of phrases) {
    if (text.includes(p)) signals.push(p);
  }

  const priceEl =
    document.querySelector(".a-price .a-offscreen") ||
    document.querySelector("#corePrice_feature_div .a-offscreen") ||
    document.querySelector("#priceblock_ourprice");
  const priceText = priceEl ? String(priceEl.textContent).trim() : null;

  return { textSignals: signals, priceText, requiresSession };
}

// ---------------------------------------------------------------------------
// Handlers — each returns the contract shape and NEVER throws.
// ---------------------------------------------------------------------------

async function handleSearch(body) {
  const marketplace = typeof body.marketplace === "string" ? body.marketplace : "amazon.fr";
  const query = typeof body.query === "string" ? body.query : "";
  const max = Number.isFinite(body.max) && body.max > 0 ? Math.floor(body.max) : 15;
  if (!query.trim()) return { items: [] };

  const host = hostFor(marketplace);
  const searchUrl = `https://${host}/s?k=${encodeURIComponent(query)}`;

  try {
    return await withPage(marketplace, async (page) => {
      let raw = [];
      // Amazon's grid is client-hydrated; the first render is sometimes empty.
      // Re-navigate up to SEARCH_NAV_RETRIES times until results appear.
      for (let attempt = 0; attempt < SEARCH_NAV_RETRIES; attempt++) {
        await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
        if (attempt === 0) await dismissConsent(page);
        await page
          .waitForSelector('div[data-component-type="s-search-result"]', { timeout: SEARCH_WAIT_MS })
          .catch(() => {});
        raw = await page.evaluate(scrapeSearchResultsInPage).catch(() => []);
        if (Array.isArray(raw) && raw.length > 0) break;
        await page.waitForTimeout(1_500);
      }

      const seen = new Set();
      const items = [];
      for (const r of raw) {
        const asin = String(r.asin || "").trim();
        if (!asin || seen.has(asin)) continue;
        seen.add(asin);
        items.push({
          asin,
          title: String(r.title || ""),
          url: `https://${host}/dp/${asin}`,
          priceCents: parsePriceCents(r.priceText),
        });
        if (items.length >= max) break;
      }
      return { items };
    });
  } catch (err) {
    logError("[search] failed:", err && err.message ? err.message : err);
    return EMPTY_SEARCH;
  }
}

async function handleObserve(body) {
  const url = typeof body.url === "string" ? body.url : "";
  const marketplace = typeof body.marketplace === "string" ? body.marketplace : "amazon.fr";
  if (!url) return EMPTY_OBSERVE;

  try {
    return await withPage(marketplace, async (page) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      await dismissConsent(page);
      // Buy box + price are server-rendered; give a brief moment for late text.
      await page
        .waitForSelector("#add-to-cart-button, .a-offscreen, #buybox", { timeout: 4_000 })
        .catch(() => {});

      const scrape = await page
        .evaluate(scrapeObserveInPage, {
          phrases: SIGNAL_PHRASES,
          urlWalls: SESSION_WALL_URL_FRAGMENTS,
          textWalls: SESSION_WALL_TEXT_FRAGMENTS,
        })
        .catch(() => null);

      if (!scrape) return EMPTY_OBSERVE;
      return {
        textSignals: Array.isArray(scrape.textSignals) ? scrape.textSignals : [],
        priceText: scrape.priceText ?? null,
        requiresSession: Boolean(scrape.requiresSession),
      };
    });
  } catch (err) {
    logError("[observe] failed:", err && err.message ? err.message : err);
    return EMPTY_OBSERVE;
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Read the request body with a hard size cap; reject oversize bodies. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** True when the request carries the correct Bearer token. */
function isAuthorized(req) {
  const header = req.headers["authorization"] || "";
  const expected = `Bearer ${SCAN_TOKEN}`;
  return SCAN_TOKEN.length > 0 && header === expected;
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  const method = req.method || "GET";
  // Strip query string for routing.
  const path = (req.url || "/").split("?")[0];

  // Wrap the whole thing so a handler bug can never crash the process.
  const finish = (status) => {
    log(`${method} ${path} ${status} ${Date.now() - started}ms`);
  };

  (async () => {
    // Health check — no auth.
    if (method === "GET" && path === "/healthz") {
      sendJson(res, 200, { ok: true });
      return finish(200);
    }

    // Everything else is POST + auth.
    if (method !== "POST" || (path !== "/search" && path !== "/observe")) {
      sendJson(res, 404, { error: "not_found" });
      return finish(404);
    }

    if (!isAuthorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return finish(401);
    }

    // Parse the body (guarded).
    let body;
    try {
      const rawBody = await readBody(req);
      body = rawBody ? JSON.parse(rawBody) : {};
      if (typeof body !== "object" || body === null) throw new Error("body must be an object");
    } catch (err) {
      // Malformed / oversize request -> 400. (Auth already passed.)
      logError(`[http] bad request on ${path}:`, err && err.message ? err.message : err);
      sendJson(res, 400, { error: "bad_request" });
      return finish(400);
    }

    if (path === "/search") {
      const result = await handleSearch(body);
      sendJson(res, 200, result);
      return finish(200);
    }

    // path === "/observe"
    const result = await handleObserve(body);
    sendJson(res, 200, result);
    return finish(200);
  })().catch((err) => {
    // Absolute last-resort guard: a safe empty result, never a 500 crash.
    logError(`[http] unhandled error on ${method} ${path}:`, err && err.stack ? err.stack : err);
    try {
      if (!res.headersSent) {
        if (path === "/search") sendJson(res, 200, EMPTY_SEARCH);
        else if (path === "/observe") sendJson(res, 200, EMPTY_OBSERVE);
        else sendJson(res, 500, { error: "internal" });
      }
    } catch {
      // res already torn down — nothing more to do.
    }
    finish("ERR");
  });
});

// ---------------------------------------------------------------------------
// Startup + lifecycle
// ---------------------------------------------------------------------------

server.listen(PORT, () => {
  log(`[scanner] listening on :${PORT}`);
  if (!SCAN_TOKEN) {
    logError(
      "[scanner] WARNING: SCAN_TOKEN is empty — all authed requests will 401. " +
        "Set SCAN_TOKEN in the environment (.env).",
    );
  }
  // Warm the browser at startup so the first request isn't slow.
  getBrowser().catch((err) => {
    logError("[scanner] initial browser launch failed (will retry on first request):", err && err.message);
  });
});

// Don't let an unexpected async error tear down the process.
process.on("unhandledRejection", (reason) => {
  logError("[scanner] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  logError("[scanner] uncaughtException:", err && err.stack ? err.stack : err);
});

async function shutdown(signal) {
  log(`[scanner] ${signal} received — shutting down`);
  server.close(() => log("[scanner] http server closed"));
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
