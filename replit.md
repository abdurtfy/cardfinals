# carddesign.skin

MVP storefront and backend for a premium card-skin ecommerce site (India).

## Tech Stack

- **Runtime:** Node.js 20 (zero npm dependencies — uses only the Node standard library)
- **Server:** Plain `node:http` server in `server.js`. Serves static HTML/CSS/JS and exposes JSON API routes.
- **Storage:** Vercel KV (Upstash REST) when `KV_REST_API_URL` + `KV_REST_API_TOKEN` are set; otherwise falls back to local JSON files in `data/` (`orders.json`, `webhook-events.json`, `product-overrides.json`).
- **Frontend:** Static HTML/CSS/JS pages (`index.html`, `checkout.html`, `confirmation.html`, `admin.html`, `admin-login.html`)
- **Integrations:** Razorpay (payments), Shiprocket (shipping), Resend / SMTP (email) — all run in demo mode if env vars are missing.

## Project Layout

- `server.js` — HTTP server, API routes, webhook handlers, admin sessions, KV/file storage. Exports `requestListener`; only calls `listen()` when invoked directly, so the same module powers both the local Replit server and the Vercel serverless function.
- `api/index.js` — Vercel serverless entry point that delegates `/api/*` requests to the exported handler.
- `vercel.json` — Vercel route config: routes `/api/*` to the function; everything else is served as static assets from `public/` by Vercel's CDN.
- `package.json` — Node engine + scripts (no dependencies).
- `public/` — All frontend assets (HTML pages, CSS, JS) served as static files. Includes `store.js`, `app.js`, `checkout.js`, `confirmation.js`, `admin.js`, `admin-login.js`, all `*.html` pages, `styles.css`, and the `uploads/` directory.
- `data/` — runtime JSON storage (created on first write, used only when KV is not configured).
- `.env.example` — template for environment variables.
- `.vercelignore` — excludes Replit/local artifacts from the Vercel bundle.

## Replit Setup

- Workflow `Start application` runs `PORT=5000 node server.js`
- Server binds to `0.0.0.0:5000` so it is reachable through Replit's preview proxy
- Cache-Control no-store headers are added in non-production for static files so the proxied iframe always sees the latest code
- Admin password is stored as the `ADMIN_PASSWORD` Replit secret

## Environment Variables

All variables are optional in dev — without them the server runs in demo mode. For a real deployment you'll want at least `ADMIN_PASSWORD` plus the integrations you actually use.

| Variable | Purpose | Required for |
| --- | --- | --- |
| `PORT` | HTTP port (defaults to 4173 locally, 5000 on Replit, ignored on Vercel) | Local/Replit only |
| `NODE_ENV` | `production` disables dev no-cache headers | Production |
| `ADMIN_PASSWORD` | Login password for `/admin` | Admin dashboard |
| `KV_REST_API_URL` | Vercel KV / Upstash REST endpoint | **Vercel** (orders + product edits persistence) |
| `KV_REST_API_TOKEN` | Vercel KV / Upstash REST token | **Vercel** (orders + product edits persistence) |
| `RAZORPAY_KEY_ID` | Razorpay public key | Live payments |
| `RAZORPAY_KEY_SECRET` | Razorpay secret key | Live payments |
| `RAZORPAY_WEBHOOK_SECRET` | HMAC secret for `/api/webhooks/razorpay` | Webhook verification |
| `SHIPROCKET_EMAIL` | Shiprocket login email | Auto-create shipments |
| `SHIPROCKET_PASSWORD` | Shiprocket login password | Auto-create shipments |
| `SHIPROCKET_PICKUP_LOCATION` | Pickup nickname configured in Shiprocket | Auto-create shipments |
| `SHIPROCKET_WEBHOOK_TOKEN` | Token expected on `/api/webhooks/shipping` | Webhook verification |
| `RESEND_API_KEY` | Resend API key — used first if present | Customer emails |
| `EMAIL_FROM` | From-address for outgoing emails | Customer emails |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | SMTP fallback when Resend isn't configured | Customer emails |

## Deploying to Vercel

The repo is fully Vercel-ready.

1. Push the project to GitHub and import it into Vercel (Framework preset: **Other**).
2. In Vercel → Storage, add **Vercel KV** (or any Upstash Redis instance) and connect it to the project. Vercel auto-injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
3. In Project Settings → Environment Variables, add the variables from the table above that you need (at minimum `ADMIN_PASSWORD`; add Razorpay/Shiprocket/Resend keys when going live).
4. Deploy. Vercel will build from `vercel.json`:
   - All requests are rewritten to `/api/index.js`, which calls the handler exported from `server.js`.
   - Static HTML/CSS/JS files at the project root and seed data in `data/` are bundled in via `includeFiles`.
5. Configure webhooks once the URL is live:
   - Razorpay → `https://<your-domain>/api/webhooks/razorpay` (use `RAZORPAY_WEBHOOK_SECRET`)
   - Shiprocket → `https://<your-domain>/api/webhooks/shipping?token=<SHIPROCKET_WEBHOOK_TOKEN>`

### How storage works on Vercel

- When `KV_REST_API_URL` + `KV_REST_API_TOKEN` are present, all orders, processed-webhook IDs, and product overrides (name/price/stock/description/image) are persisted in Vercel KV under the keys `orders`, `webhook_events`, and `products`.
- Image uploads from the admin dashboard are stored **inline as base64 data URLs** inside the product override (capped at 1.5 MB). This avoids needing a separate blob store and works on Vercel's read-only filesystem.
- Without KV, the app still works (it falls back to JSON files under `data/`), but those writes won't survive serverless cold starts on Vercel — KV is required for any real Vercel deploy.
