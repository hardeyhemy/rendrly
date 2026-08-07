# Rendrly — Agent Build Architecture & Task Backlog

## Architecture

```
GitHub repo (rendrly)
 ├─ main (protected — no direct pushes)
 ├─ GLM agent works on task/<slug> branches, opens PRs
 ├─ Human review gate: PR merge = deploy trigger
 └─ .github/workflows/
     ├─ deploy.yml   — deploys worker.js to Cloudflare on push to main
     └─ check.yml    — (added below, Task 0) syntax/lint check on every PR
```

**Secrets split — GLM never touches Cloudflare/Lemon Squeezy/Brevo credentials directly:**
- GitHub Actions secrets (deploy-time only): `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
- Cloudflare Worker secrets (runtime only, set via dashboard, invisible to the repo): `LEMONSQUEEZY_WEBHOOK_SECRET`, `ADMIN_TOKEN`, `BREVO_API_KEY`
- GLM's code only ever references `env.VARIABLE_NAME` — it writes code that *expects* the secret, never sees the value.

**Review gate:** every PR must pass `check.yml` (automated) before a human merges. Merge → auto-deploy. This is the only place approval happens — you don't need to touch the Cloudflare dashboard again after initial setup.

---

## Guardrails baked into every task prompt

Two things belong in *every* task you give the agent, non-negotiably:

1. **SSRF guard reminder** — this API fetches arbitrary user-supplied URLs server-side. Any task touching `takeScreenshot`/`renderPdf` must preserve (or, in Task 1, add) a check that blocks internal/private IP ranges (`localhost`, `127.0.0.1`, `169.254.*`, `10.*`, `172.16-31.*`, `192.168.*`, `file://`, `.internal` TLDs). Without this, anyone can use your Worker to port-scan your own Cloudflare network or hit cloud metadata endpoints. This is the single highest-priority item — build it before anything customer-facing.
2. **No dependency additions requiring a build step.** Single-file ES module stays single-file.

---

## Task Backlog (feed one at a time, in this order)

### Task 0 — PR check workflow (do this first, before any feature work)
```
TASK
Add .github/workflows/check.yml that runs on every pull_request targeting main.
It should: checkout the repo, install Node, run `node --check worker.js` to
verify syntax, and fail the build if that check fails. No other test framework
needed yet — this is a minimal gate, not a full test suite.
```

### Task 1 — SSRF guard (highest priority, do this before Task 2)
```
TASK
Add a function `isBlockedTarget(url)` that rejects requests where the hostname
resolves to or is literally: localhost, 127.0.0.1, 0.0.0.0, any 169.254.x.x
(link-local/cloud metadata), any 10.x.x.x, 172.16-31.x.x, 192.168.x.x (private
ranges), any .internal/.local TLD, or non-http(s) schemes. Call this check in
handleApiRequest before takeScreenshot/renderPdf run, and return a 400 with
{"error":"blocked_target"} if it matches. Add a short comment explaining why
this exists (SSRF protection — the API fetches arbitrary user URLs server-side).
```

### Task 2 — Brevo transactional email on key provisioning
```
TASK
In handleLemonSqueezyWebhook, after a new API key is successfully inserted into
D1, send the key to the buyer's email using Brevo's transactional email API
(POST https://api.brevo.com/v3/smtp/email, header api-key: env.BREVO_API_KEY).
Plain HTML body, no template engine. Subject: "Your Rendrly API key". Include
the key, a curl example hitting /v1/screenshot, and a link to README-derived
docs. If the Brevo call fails, log it but do not fail the webhook response —
the key must still be provisioned even if email delivery fails.
```

### Task 3 — Self-serve usage endpoint
```
TASK
Add GET /v1/usage (authenticated the same way as other /v1/ routes) that
returns { plan, dailyLimit, usedToday, remaining, resetAt } for the calling
key, reading from the existing usage: KV keys. This does not count against
the daily quota itself.
```

### Task 4 — Rate-limit response headers
```
TASK
On every /v1/ response (success or 429), add headers X-RateLimit-Limit,
X-RateLimit-Remaining, X-RateLimit-Reset. Compute from the same usage data
already used in checkAndIncrementUsage — don't add a second data source.
```

### Task 5 — Favicon endpoint
```
TASK
Add GET /v1/favicon?url=<url>&key=<api_key> that returns a site's favicon as
PNG, resizing to 64x64 if larger. Use the existing BROWSER binding's screenshot
capability targeting the favicon URL (derive from /favicon.ico at the target
origin, falling back to parsing <link rel="icon"> from the page HTML if that
404s). Reuse the existing SSRF guard from Task 1.
```

### Task 6 — Link preview / metadata endpoint
```
TASK
Add GET /v1/metadata?url=<url>&key=<api_key> that returns JSON:
{ title, description, ogImage, favicon }, scraped from the page's <head> via
the BROWSER binding's HTML-extraction capability. Reuse the existing SSRF guard.
```

### Task 7 — OpenAPI spec + RapidAPI manifest
```
TASK
Add openapi.yaml at the repo root describing all current /v1/ endpoints
(screenshot, pdf, og, usage, favicon, metadata) with query params, auth scheme
(apiKey in query or x-api-key header), and example responses, matching what's
actually implemented in worker.js — read the file first, don't invent params
that don't exist. This will be used for a RapidAPI listing later.
```

### Task 8 — Minimal landing/docs page
```
TASK
Add a GET / (root) HTML response (replacing the current JSON health check —
move health check to GET /health instead) rendering a single self-contained
HTML page: product name "Rendrly", one-line pitch, the three plan tiers with
prices from PLANS, curl examples for each endpoint, and a link to the Lemon
Squeezy checkout URL (use a placeholder LEMONSQUEEZY_CHECKOUT_URL constant at
the top of the file for me to fill in). No external CSS framework — inline
<style>, dark background, system font stack.
```

---

## Review checklist (use for every PR before merging)

- [ ] `check.yml` passed
- [ ] SSRF guard untouched or correctly extended if the task touched fetch logic
- [ ] No new npm dependencies / no build step introduced
- [ ] Existing bindings (`BROWSER`, `DB`, `API_KEYS`) and plan tiers unchanged unless task said to change them
- [ ] Secrets referenced only as `env.X`, never hardcoded
- [ ] PR description lists assumptions — read them, they're often where scope drifted
