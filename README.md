# AWP scanner

A thin, standalone **Node + Playwright** service that reads **PUBLIC Amazon
pages with a real headless browser** and returns RAW signals to the AWP
Cloudflare Worker.

## Why this exists

Amazon serves a JavaScript anti-bot challenge to plain HTTP fetches — only a
real browser that executes the page JS gets the real HTML. Cloudflare Browser
Rendering is quota-capped/paid, so AWP hosts the browser for **free** on an
Oracle Cloud Always Free VM. The Worker calls this service over a **Cloudflare
Tunnel** (outbound only — no inbound ports to open).

The scanner is intentionally **"thin"**: it returns raw signals (button /
availability text, the displayed price, search-result ASINs). It contains **no
detection or business logic** — the Worker's plugin detectors keep all of that.

> No Amazon login, no cookies, no captcha solving. Just a real browser with
> standard desktop headers (`User-Agent` + per-marketplace `Accept-Language`).

## HTTP contract

The Worker depends on these shapes exactly.

| Method & path | Auth | Body | Response (200) |
|---|---|---|---|
| `GET /healthz` | none | — | `{ "ok": true }` |
| `POST /search` | Bearer | `{ "marketplace": string, "query": string, "max": number }` | `{ "items": SearchItem[] }` |
| `POST /observe` | Bearer | `{ "url": string, "marketplace": string }` | `{ "textSignals": string[], "priceText": string \| null, "requiresSession": boolean }` |

```ts
type SearchItem = { asin: string; title: string; url: string; priceCents: number | null };
```

- **Auth**: header `Authorization: Bearer <SCAN_TOKEN>`. Missing/wrong →
  `401 { "error": "unauthorized" }`. The token comes from the `SCAN_TOKEN` env var.
- **Errors never crash**: on any internal error the service returns a *safe empty
  result* with HTTP 200 (`/search` → `{items:[]}`, `/observe` →
  `{textSignals:[],priceText:null,requiresSession:true}`) and logs the cause.
- **Malformed/oversize request** (after auth) → `400 { "error": "bad_request" }`.

### Supported marketplaces

`amazon.fr`, `amazon.com`, `amazon.co.uk`, `amazon.de`, `amazon.es`,
`amazon.it`, `amazon.co.jp`. Unknown/empty → defaults to `amazon.fr`.

## How it works (browser behaviour)

- One shared headless Chromium, launched at startup and **reused** across
  requests; **recycled** (close + relaunch) every ~80 requests to avoid memory
  growth.
- Each request opens a fresh context/page that **blocks images, stylesheets,
  fonts and media** (all the data we need is in the HTML/DOM).
- `goto(..., { waitUntil: "domcontentloaded", timeout: 20000 })`, then tries to
  click the cookie-consent button `#sp-cc-accept` (ignored if absent).
- **/search**: opens `https://<host>/s?k=<query>`, waits for the results grid,
  retries the navigation up to 3× if zero results render, then extracts
  `asin` / `title` / price from each result card.
- **/observe**: opens the product URL, flags `requiresSession` on a
  robot/captcha/sign-in wall, otherwise reports which buy/availability phrases
  appear in the page text plus the displayed price string.

## Run locally

Requires **Node 18+**.

```bash
cd scanner
npm ci                                 # or: npm install
npx playwright install chromium        # downloads the browser (not bundled)
SCAN_TOKEN=dev-secret node src/server.js
```

> On Linux, use `npx playwright install --with-deps chromium` so the OS
> libraries Chromium needs are installed too. On Windows/macOS the plain
> `npx playwright install chromium` is enough.

The server logs `[scanner] listening on :8080`. Configure via env:

- `SCAN_TOKEN` — shared bearer secret (required; empty ⇒ every authed request 401s).
- `PORT` — listen port (default `8080`).

You can also copy `.env.example` to `.env`. (The bundled systemd unit loads
`.env`; running `node src/server.js` directly does **not** auto-load it — pass
the vars inline as above, or `set -a; source .env; set +a` first.)

## Test with curl

```bash
# Health (no auth)
curl http://localhost:8080/healthz
# -> {"ok":true}

# Auth failure
curl -i -X POST http://localhost:8080/search
# -> HTTP/1.1 401 ... {"error":"unauthorized"}

# Search
curl -X POST http://localhost:8080/search \
  -H "Authorization: Bearer dev-secret" \
  -H "content-type: application/json" \
  -d '{"marketplace":"amazon.fr","query":"pokemon coffret dresseur elite","max":5}'
# -> {"items":[{"asin":"...","title":"...","url":"https://www.amazon.fr/dp/...","priceCents":3499}, ...]}

# Observe a product page
curl -X POST http://localhost:8080/observe \
  -H "Authorization: Bearer dev-secret" \
  -H "content-type: application/json" \
  -d '{"marketplace":"amazon.fr","url":"https://www.amazon.fr/dp/B0XXXXXXXX"}'
# -> {"textSignals":["ajouter au panier","en stock"],"priceText":"34,99 €","requiresSession":false}
```

## Deploy to Oracle Cloud + Cloudflare Tunnel

See **[SETUP.md](./SETUP.md)** for a full step-by-step guide (free VM, swap
fallback, systemd, tunnel, and wiring the Worker).

## Files

| File | Purpose |
|---|---|
| `src/server.js` | HTTP server (`node:http`) + Playwright logic. |
| `src/parse.js` | `parsePriceCents`, marketplace host/locale maps, signal phrases. |
| `.env.example` | Copy to `.env`. |
| `awp-scanner.service` | systemd unit. |
| `SETUP.md` | Oracle + Cloudflare Tunnel deployment guide. |
