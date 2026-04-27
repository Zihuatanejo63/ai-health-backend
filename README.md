# AI Health Match Backend

Cloudflare Worker backend for AI Health Match.

## Run locally

```bash
npm install
npm run dev
```

## Deploy

```bash
npx wrangler login
npx wrangler secret put GEMINI_API_KEY
npx wrangler d1 migrations apply ai_health_match --remote
npm run deploy
```

Payments are configured with a hosted checkout link from a merchant-of-record provider such as Paddle or Lemon Squeezy.

Add this to `wrangler.toml` after you create a product or subscription checkout link:

```toml
PAYMENT_PROVIDER = "lemon_squeezy"
PAYMENT_CHECKOUT_URL = "https://your-provider-checkout-link"
```

Without `PAYMENT_CHECKOUT_URL`, the symptom analysis API still works and checkout returns a clear configuration error.

## Database

The Worker stores each successful AI triage request and checkout-created order records in Cloudflare D1.

- Binding: `DB`
- Database: `ai_health_match`
- Migrations:
  - `migrations/0001_cases.sql`
  - `migrations/0002_case_output_language.sql`
  - `migrations/0003_users_orders_doctor_requests.sql`
  - `migrations/0004_provider_neutral_orders.sql`
  - `migrations/0005_rate_limits_api_logs.sql`

For privacy minimization, the Worker no longer stores full symptom text in D1. It stores the case reference, severity, duration, selected output language, AI summary, suggested departments, next steps, and a redacted symptom-length marker.

## API

- `POST /api/analyze-symptoms`
- `POST /api/create-checkout-session`

The API applies basic per-client rate limits and records minimal operational logs in D1 using hashed client identifiers.

## Payments

This MVP uses hosted payment links from Paddle or Lemon Squeezy first. This avoids taking card data directly and is easier for a one-person company to validate willingness to pay before forming an offshore company and moving to Stripe.

Before real payments:

1. Create a product or subscription in Paddle or Lemon Squeezy.
2. Add the hosted checkout URL to `PAYMENT_CHECKOUT_URL`.
3. Confirm refund, scheduling, cancellation, provider qualification, and medical compliance workflows.
