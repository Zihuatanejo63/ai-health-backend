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

## Database

The Worker stores each successful AI triage request in Cloudflare D1.

- Binding: `DB`
- Database: `ai_health_match`
- Migration: `migrations/0001_cases.sql`
