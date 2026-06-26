/**
 * AWP scanner — Playwright engine.
 *
 * Runs a REAL headless Chromium and reads PUBLIC Amazon pages. A real browser
 * executes the page JS, so it passes Amazon's anti-bot wall where a plain HTTP
 * fetch would only get the challenge page.
 *
 * It is deliberately "thin": it returns RAW signals (button/availability text,
 * the displayed price, search-result asins) — NO detection/business logic. The
 * Worker keeps all of that. No Amazon login, no cookies, no captcha bypass: just
 * a real browser + standard desktop headers.
 *
 * Exposed:
 *   runSearch({ marketplace, query, max })  -> { items: SearchItem[] }
 *   runObserve({ url, marketplace })        -> { textSignals, priceText, requiresSession }
 *   shutdownBrowser()                       -> closes the shared browser
 *
 * Both run* functions NEVER throw — on any internal error they return a SAFE
 * empty result and log.
 */

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

const NAV_TIMEOUT_MS = 20_000; // goto timeout
const SEARCH_WAIT_MS = 10_000; // wait for the results grid
const SEARCH_NAV_RETRIES = 3; // re-navigate if zero results render
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

/** Warm the browser at startup so the first request isn't slow. */
export function warmBrowser() {
  return getBrowser().catch((err) =>
    logError("[scanner] initial browser launch failed (will retry on first request):", err && err.message),
  );
}

export async function shutdownBrowser() {
  if (browser) await browser.close().catch(() => {});
  browser = null;
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
    locale: acceptLanguageFor(marketplace).split(",")[0] || "fr-FR",
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

/** Runs in the page context. Returns each search result's asin/title/price. */
function scrapeSearchResultsInPage() {
  const out = [];
  const nodes = document.querySelectorAll(
    'div[data-component-type="s-search-result"][data-asin], div.s-result-item[data-asin]',
  );
  for (const node of nodes) {
    const asin = String(node.getAttribute("data-asin") || "").trim();
    if (!asin) continue;
    const titleEl =
      node.querySelector("h2 a span") || node.querySelector("h2 span") || node.querySelector("h2 a");
    const title = String(titleEl ? titleEl.textContent : "").trim();
    const priceEl = node.querySelector(".a-price .a-offscreen");
    const priceText = priceEl ? String(priceEl.textContent).trim() : null;
    out.push({ asin, title, priceText });
  }
  return out;
}

/** Runs in the page context. Reads buy/availability signals, price, robot wall. */
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
// Public handlers — each returns the contract shape and NEVER throws.
// ---------------------------------------------------------------------------

export async function runSearch(body) {
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

export async function runObserve(body) {
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
