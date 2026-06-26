/**
 * Pure helpers shared by the scanner server: price parsing, the per-marketplace
 * host map + Accept-Language, and the buy/availability signal phrases. Kept
 * dependency-free so it can be unit-tested with plain `node`.
 *
 * This mirrors the AWP Worker's previous browser engine (cloud-browser.ts) and
 * `@awp/core` parsePriceCents so the scanner returns the exact same raw signals
 * the Worker's detectors already expect.
 */

/** Public host per marketplace (used to build product + search URLs). */
export const MARKETPLACE_HOST = {
  "amazon.fr": "www.amazon.fr",
  "amazon.com": "www.amazon.com",
  "amazon.co.uk": "www.amazon.co.uk",
  "amazon.de": "www.amazon.de",
  "amazon.es": "www.amazon.es",
  "amazon.it": "www.amazon.it",
  "amazon.co.jp": "www.amazon.co.jp",
};

/** Default host when an unknown/empty marketplace is supplied. */
export const DEFAULT_HOST = "www.amazon.fr";

/** Resolve a marketplace code to its public host (falls back to amazon.fr). */
export function hostFor(marketplace) {
  return MARKETPLACE_HOST[marketplace] ?? DEFAULT_HOST;
}

/**
 * Accept-Language per marketplace so Amazon serves the localized page (button
 * labels, availability banners) the Worker's detectors are matched against.
 */
export const ACCEPT_LANGUAGE = {
  "amazon.fr": "fr-FR,fr;q=0.9,en;q=0.5",
  "amazon.com": "en-US,en;q=0.9",
  "amazon.co.uk": "en-GB,en;q=0.9",
  "amazon.de": "de-DE,de;q=0.9,en;q=0.5",
  "amazon.es": "es-ES,es;q=0.9,en;q=0.5",
  "amazon.it": "it-IT,it;q=0.9,en;q=0.5",
  "amazon.co.jp": "ja-JP,ja;q=0.9,en;q=0.5",
};

/** Accept-Language header value for a marketplace (defaults to fr-FR). */
export function acceptLanguageFor(marketplace) {
  return ACCEPT_LANGUAGE[marketplace] ?? ACCEPT_LANGUAGE["amazon.fr"];
}

/** A normal, current desktop Chrome User-Agent (no evasion — just realistic). */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/**
 * Buy / availability phrases. The scanner reports which appear in the page's
 * (lowercased) innerText; the Worker turns these raw signals into a state.
 * Phrases must be lowercase (we match against lowercased innerText).
 */
export const SIGNAL_PHRASES = [
  "ajouter au panier",
  "add to cart",
  "acheter maintenant",
  "buy now",
  "en stock",
  "in stock",
  "カートに入れる",
  "今すぐ買う",
  "在庫あり",
  "demander une invitation",
  "request invitation",
  "request an invitation",
  "招待をリクエスト",
  "リクエストを送信",
  "actuellement indisponible",
  "currently unavailable",
  "indisponible",
  "在庫切れ",
];

/**
 * Substrings/URL fragments that indicate a robot/captcha/sign-in wall. When the
 * final URL or the page body matches any of these, the page is unreadable and
 * the scanner reports requiresSession=true (it never tries to bypass anything).
 */
export const SESSION_WALL_URL_FRAGMENTS = [
  "/ap/signin",
  "/errors/validatecaptcha",
];

export const SESSION_WALL_TEXT_FRAGMENTS = [
  "enter the characters you see",
  "type the characters you see in this image",
  "entrez les caractères",
  "to discuss automated access",
];

/**
 * Parse a displayed price string into minor units (cents), or null.
 *
 * Handles FR ("12,34 €", non-breaking spaces, "1 234,56 €") and US ("$12.34",
 * "$1,234.56"). The decimal separator is whichever of "," / "." appears last;
 * the other is treated as a thousands separator and stripped. Mirrors
 * `@awp/core` parsePriceCents exactly.
 */
export function parsePriceCents(priceText) {
  if (!priceText) return null;

  // Normalize non-breaking spaces / &nbsp; away, then keep only digits + . , .
  const cleaned = String(priceText)
    .replace(/ /g, " ")
    .replace(/&nbsp;?/gi, " ")
    .replace(/[^0-9.,]/g, "");
  if (!cleaned) return null;

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");
  // The decimal separator is whichever appears last (FR ",", US ".").
  const decimalSep = lastComma > lastDot ? "," : lastDot > lastComma ? "." : "";

  let normalized;
  if (decimalSep) {
    const thousandSep = decimalSep === "," ? "." : ",";
    normalized = cleaned.split(thousandSep).join("").replace(decimalSep, ".");
  } else {
    normalized = cleaned;
  }

  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}
