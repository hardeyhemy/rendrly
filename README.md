# CaptureFlare

Screenshot / PDF / OG-image API on Cloudflare Workers. Single-file, no build step.

## Endpoints

- `GET /v1/screenshot?url=<url>&key=<api_key>&format=png|jpeg&fullPage=true|false&width=&height=`
- `GET /v1/pdf?url=<url>&key=<api_key>&size=A4|Letter`
- `GET /v1/og?title=<text>&subtitle=<text>&key=<api_key>`

Auth: pass the key as `?key=` or header `x-api-key`.

## Plans (edit in `worker.js` → `PLANS`)

| Plan    | Daily limit | Suggested price |
|---------|-------------|------------------|
| free    | 50          | $0               |
| starter | 2,000       | $9/mo            |
| pro     | 20,000      | $29/mo           |

## Deploy (dashboard, no CLI — matches existing workflow)

1. Cloudflare dashboard → Workers & Pages → Create → Create Worker.
2. Name it `captureflare` → Deploy the default hello-world → Edit code → paste `worker.js` → Save & Deploy.
3. Worker → Settings → Bindings:
   - Add **Browser Rendering** binding, name it `BROWSER`.
   - Add **D1 database** binding, name it `DB` (create a new D1 DB `captureflare-db` from Workers & Pages → D1 first, then run `schema.sql` against it in the D1 console query tab).
   - Add **KV namespace** binding, name it `API_KEYS` (create a new KV namespace first).
4. Worker → Settings → Variables and Secrets:
   - Add secret `ADMIN_TOKEN` (any long random string — this lets you mint keys manually before Lemon Squeezy is wired up).
   - Add secret `LEMONSQUEEZY_WEBHOOK_SECRET` once you create the LS webhook (step 6).
   - Add secret `BREVO_API_KEY` (your Brevo account API key for transactional email).
   - Add secret `SENDER_EMAIL` (optional — the verified sender address for Brevo emails; defaults to `billings@revnuvo.site` if unset).
5. Mint your first test key:
   ```
   curl -X POST https://captureflare.<your-subdomain>.workers.dev/admin/keys \
     -H "x-admin-token: <ADMIN_TOKEN>" \
     -H "content-type: application/json" \
     -d '{"email":"you@example.com","plan":"pro"}'
   ```
6. Lemon Squeezy: create two variants (Starter $9/mo, Pro $29/mo) on one product. Store → Settings → Webhooks → add
   `https://captureflare.<your-subdomain>.workers.dev/webhook/lemonsqueezy`, subscribe to `order_created`,
   `subscription_created`, `subscription_cancelled`, `subscription_expired`. Copy the signing secret into
   `LEMONSQUEEZY_WEBHOOK_SECRET`.
7. Test:
   ```
   curl "https://captureflare.<your-subdomain>.workers.dev/v1/screenshot?url=https://example.com&key=<key>" --output test.png
   ```

## Not yet in this MVP (next pass)

- Transactional email on key provisioning (wire into existing Brevo account — send the key on `order_created`).
- Landing page / pricing page (static, can go on Cloudflare Pages or same Worker).
- Rate-limit headers in responses (`X-RateLimit-Remaining`).
- RapidAPI listing for extra distribution.
