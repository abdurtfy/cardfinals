# carddesign.skin

MVP storefront and backend for a premium card-skin ecommerce site.

## Run locally

```bash
node server.js
```

Open:

```text
http://localhost:4173
```

## Current MVP

- Product-first storefront with no landing-page filler
- Product catalog without filters or search
- Direct add-to-cart CTA on every product
- Persistent cart using `localStorage`
- Separate checkout page
- Local admin orders panel at `/admin.html`
- Backend API routes for Razorpay order creation and verification
- Backend API routes for Shiprocket serviceability and order creation
- Local order persistence in `data/orders.json`

## Environment Variables

Create a local `.env` file using `.env.example` as the template, then add:

```bash
export RAZORPAY_KEY_ID="rzp_live_or_test_key"
export RAZORPAY_KEY_SECRET="razorpay_secret"
export SHIPROCKET_EMAIL="shiprocket_login_email"
export SHIPROCKET_PASSWORD="shiprocket_password"
export SHIPROCKET_PICKUP_LOCATION="Primary"
export ADMIN_PASSWORD="change_this_password"
export RESEND_API_KEY="resend_api_key"
export EMAIL_FROM="orders@carddesign.skin"
export SMTP_HOST="smtp.gmail.com"
export SMTP_PORT="465"
export SMTP_USER="your_email@gmail.com"
export SMTP_PASS="gmail_app_password"
export RAZORPAY_WEBHOOK_SECRET="change_this_webhook_secret"
export SHIPROCKET_WEBHOOK_TOKEN="change_this_shiprocket_token"
```

Without these values, the backend runs in demo mode so the flow can still be tested.
The `.env` file is ignored by git and is loaded by `server.js` automatically.

### Razorpay

Implemented routes:

- `POST /api/razorpay/order`
- `POST /api/razorpay/verify`
- `POST /api/webhooks/razorpay`

Still recommended before production:

- Persist orders and payment attempts in a database
- Add refund handling if you enable refunds from the admin panel later

### Shiprocket

Implemented routes:

- `POST /api/shiprocket/serviceability`
- `POST /api/webhooks/shiprocket?token=SHIPROCKET_WEBHOOK_TOKEN`
- Shiprocket order creation after Razorpay verification
- Order confirmation and shipping follow-up email hooks after payment

### Webhook URLs

Use these public URLs after deployment:

```text
https://your-domain.com/api/webhooks/razorpay
https://your-domain.com/api/webhooks/shiprocket?token=SHIPROCKET_WEBHOOK_TOKEN
```

For Razorpay, set the dashboard webhook secret to the same value as `RAZORPAY_WEBHOOK_SECRET`.

Still recommended before production:

- Store Shiprocket order IDs and AWB/tracking data
- Build admin label generation and fulfillment views
- Send customer email/SMS notifications

## Admin Panel

Open:

```text
http://localhost:4173/admin.html
```

The admin panel shows order IDs, addresses, customer contact details, payment status, Shiprocket status, totals, and item quantities.
The admin panel is protected by an HTTP-only session cookie. Set `ADMIN_PASSWORD` in `.env`, then log in at `/admin-login.html`.

## Suggested Next Build Step

Move this MVP into a database-backed app with:

- PostgreSQL product, order, and payment tables
- Admin product/order dashboard
- Auth-protected admin pages
