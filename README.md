# AWP scanner

A self-hosted **Node + Playwright** worker that reads **PUBLIC Amazon pages with
a real headless browser** and answers the AWP Cloudflare Worker with RAW signals.

## Why this exists

Amazon serves a JavaScript anti-bot challenge to plain HTTP fetches — only a real
browser that executes the page JS gets the real HTML. Cloudflare Browser
Rendering is quota-capped/paid, so AWP hosts the browser for **free** on the
user's own always-on box (e.g. a HomeLab server — residential IP, which Amazon
challenges far less than datacenter IPs).

The scanner is intentionally **"thin"**: it returns raw signals (button /
availability text, the displayed price, search-result ASINs). It contains **no
detection or business logic** — the Worker's plugin detectors keep all of that.

> No Amazon login, no cookies, no captcha solving. Just a real browser with
> standard desktop headers (`User-Agent` + per-marketplace `Accept-Language`).

## Architecture — the scanner dials OUT

The scanner does **not** listen for inbound requests. It opens a **persistent
outbound WebSocket** to the Worker and answers scan requests on it:

```
   Cloudflare Worker  ──(holds socket in a Durable Object)
          ▲
          │  wss://…/ws/scanner   (the scanner dials out, Bearer SCAN_TOKEN)
          │
   HomeLab scanner (this) ── real Chromium
```

Why outbound: a Cloudflare Worker can't reach into a tailnet, and Tailscale
Funnel is unreachable from Workers (its DNS isn't served to `1.1.1.1`). Inverting
the link means **no inbound port, no tunnel, no public ingress** — the box stays
locked down (Tailscale remains the only ingress) and there's nothing to expose.

### Protocol (JSON text frames over the WS)

| Direction | Frame | Meaning |
|---|---|---|
| Worker → scanner | `{ id, type: "search", payload: { marketplace, query, max } }` | run a search |
| Worker → scanner | `{ id, type: "observe", payload: { url, marketplace } }` | read a product page |
| scanner → Worker | `{ id, result }` | reply to request `id` |
| scanner → Worker | `{ "type": "ping" }` | keepalive |

```ts
// search result
{ items: { asin: string; title: string; url: string; priceCents: number | null }[] }
// observe result
{ textSignals: string[]; priceText: string | null; requiresSession: boolean }
```

- **Auth**: the WS connects with `Authorization: Bearer <SCAN_TOKEN>`; the Worker
  rejects a wrong/missing token with `401`. The token comes from `SCAN_TOKEN`.
- **Errors never crash**: on any internal error a *safe empty result* is returned
  (`search` → `{items:[]}`, `observe` →
  `{textSignals:[],priceText:null,requiresSession:true}`) and the cause is logged.
- **Auto-reconnect**: drops are retried with backoff; protocol pings detect dead
  links.

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
- **search**: opens `https://<host>/s?k=<query>`, waits for the results grid,
  retries the navigation up to 3× if zero results render, then extracts
  `asin` / `title` / price from each result card.
- **observe**: opens the product URL, flags `requiresSession` on a
  robot/captcha/sign-in wall, otherwise reports which buy/availability phrases
  appear in the page text plus the displayed price string.

## Configuration (env)

| Var | Required | Default | Purpose |
|---|---|---|---|
| `SCAN_TOKEN` | yes | — | shared secret; MUST match the Worker's `SCAN_TOKEN` |
| `WORKER_WS_URL` | no | `wss://awp-api.kihwouih.workers.dev/ws/scanner` | Worker endpoint to dial |
| `PORT` | no | `8080` | local `/healthz` port (ops checks only) |
| `CHROMIUM_PATH` | no | — | host Chromium path (non-bundled installs) |

## Run locally

Requires **Node 18+**.

```bash
npm install
npx playwright install chromium                 # downloads the browser (not bundled)
SCAN_TOKEN=dev-secret WORKER_WS_URL=wss://your-worker/ws/scanner node src/client.js
```

> On Linux use `npx playwright install --with-deps chromium`. The container image
> (see `Dockerfile`) bundles Chromium already — nothing to install.

The process logs `[ws] connected to Worker` once the link is up. Check it:

```bash
curl http://localhost:8080/healthz
# -> {"ok":true,"connected":true,"worker":"wss://…/ws/scanner"}
```

`connected:false` means the outbound WS isn't established (wrong token, wrong URL,
or the Worker is down) — check the logs.

## Run with Docker

```bash
SCAN_TOKEN=$(openssl rand -hex 24) docker compose up --build
```

## Files

| File | Purpose |
|---|---|
| `src/client.js` | Outbound WebSocket client + local `/healthz` (entrypoint). |
| `src/scan.js` | Playwright engine: `runSearch` / `runObserve`. |
| `src/parse.js` | `parsePriceCents`, marketplace host/locale maps, signal phrases. |
| `Dockerfile` | Playwright base image (Chromium bundled). |
| `.env.example` | Copy to `.env`. |
