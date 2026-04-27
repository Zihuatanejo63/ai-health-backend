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
npm run deploy
```
