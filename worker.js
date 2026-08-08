/**
 * CaptureFlare — Screenshot / PDF / OG-image API on Cloudflare Workers
 * Single-file ES module. No build step. Paste directly into Cloudflare
 * dashboard Quick Edit, or deploy with `wrangler deploy`.
 *
 * Bindings required (set in wrangler.toml or dashboard > Settings > Bindings):
 *   - BROWSER      -> Browser Rendering binding
 *   - DB           -> D1 database (schema.sql)
 *   - API_KEYS     -> KV namespace (fast key lookups, cached from D1)
 *
 * Env vars (secrets):
 *   - LEMONSQUEEZY_WEBHOOK_SECRET
 *   - ADMIN_TOKEN  (for manually minting keys before LS webhook is wired up)
 *   - BREVO_API_KEY (transactional email — sends API key on purchase)
 *   - SENDER_EMAIL  (optional — Brevo sender address, defaults to billings@revnuvo.site)
 *
 * SSRF protection — isBlockedTarget(url) exists because this API fetches
 * arbitrary user-supplied URLs server-side (to take screenshots, render PDFs,
 * etc.).  Without a guard, an attacker could coax the Worker into reaching
 * internal services, cloud metadata endpoints (169.254.169.254), or the
 * loopback interface.  The function rejects non-http(s) schemes, loopback
 * hostnames, link-local / private IP ranges, and .internal/.local TLDs.
 */

const PLANS = {
  free:    { dailyLimit: 50,   name: "Free" },
  starter: { dailyLimit: 2000, name: "Starter" },   // $9/mo
  pro:     { dailyLimit: 20000,name: "Pro" },       // $29/mo
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" || path === "/health") {
      return json({ ok: true, service: "captureflare", version: "0.1.0" });
    }

    if (path === "/webhook/lemonsqueezy" && request.method === "POST") {
      return handleLemonSqueezyWebhook(request, env, ctx);
    }

    if (path === "/admin/keys" && request.method === "POST") {
      return handleAdminCreateKey(request, env);
    }

    if (path.startsWith("/v1/")) {
      return handleApiRequest(request, env, path, url);
    }

    return json({ error: "not_found" }, 404);
  },
};

// ---------- Core API ----------

async function handleApiRequest(request, env, path, url) {
  const auth = await authenticate(request, env);
  if (!auth.ok) return json({ error: auth.error }, 401);

  // /v1/usage is read-only — does not count against the daily quota
  if (path === "/v1/usage") {
    return handleUsageRequest(env, auth.keyRecord);
  }

  const usage = await checkAndIncrementUsage(env, auth.keyRecord);
  if (!usage.ok) {
    return json(
      { error: "quota_exceeded", limit: usage.limit, resetAt: usage.resetAt },
      429
    );
  }

  const target = url.searchParams.get("url");
  if (!target && path !== "/v1/og") {
    return json({ error: "missing_url_param" }, 400);
  }

  // SSRF gate — reject internal/private targets before any outbound fetch
  if (target && isBlockedTarget(target)) {
    return json({ error: "blocked_target" }, 400);
  }

  try {
    switch (path) {
      case "/v1/screenshot":
        return await takeScreenshot(env, target, url.searchParams);
      case "/v1/pdf":
        return await renderPdf(env, target, url.searchParams);
      case "/v1/og":
        return await renderOgImage(env, url.searchParams);
      default:
        return json({ error: "unknown_endpoint" }, 404);
    }
  } catch (err) {
    return json({ error: "render_failed", message: String(err) }, 500);
  }
}

async function takeScreenshot(env, target, params) {
  const fullPage = params.get("fullPage") === "true";
  const format = params.get("format") === "jpeg" ? "jpeg" : "png";
  const width = clampInt(params.get("width"), 1920, 320, 3840);
  const height = clampInt(params.get("height"), 1080, 240, 3840);

  const resp = await env.BROWSER.fetch("https://browser-rendering/screenshot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: target,
      screenshotOptions: { fullPage, type: format },
      viewport: { width, height },
    }),
  });

  if (!resp.ok) return json({ error: "browser_rendering_error" }, 502);
  const buf = await resp.arrayBuffer();
  return new Response(buf, {
    headers: {
      "content-type": format === "jpeg" ? "image/jpeg" : "image/png",
      "cache-control": "public, max-age=300",
    },
  });
}

async function renderPdf(env, target, params) {
  const resp = await env.BROWSER.fetch("https://browser-rendering/pdf", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: target,
      pdfOptions: {
        format: params.get("size") || "A4",
        printBackground: true,
      },
    }),
  });

  if (!resp.ok) return json({ error: "browser_rendering_error" }, 502);
  const buf = await resp.arrayBuffer();
  return new Response(buf, {
    headers: {
      "content-type": "application/pdf",
      "cache-control": "public, max-age=300",
    },
  });
}

async function renderOgImage(env, params) {
  const title = (params.get("title") || "").slice(0, 120);
  const subtitle = (params.get("subtitle") || "").slice(0, 160);

  const html = `<!doctype html><html><head><meta charset="utf-8">
  <style>
    body{margin:0;width:1200px;height:630px;display:flex;flex-direction:column;
      justify-content:center;padding:80px;background:linear-gradient(135deg,#0f172a,#1e293b);
      font-family:-apple-system,Helvetica,Arial,sans-serif;color:#fff;box-sizing:border-box}
    h1{font-size:64px;margin:0 0 24px 0;line-height:1.1;font-weight:700}
    p{font-size:28px;color:#94a3b8;margin:0}
  </style></head>
  <body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></body></html>`;

  const resp = await env.BROWSER.fetch("https://browser-rendering/screenshot", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      html,
      screenshotOptions: { type: "png" },
      viewport: { width: 1200, height: 630 },
    }),
  });

  if (!resp.ok) return json({ error: "browser_rendering_error" }, 502);
  const buf = await resp.arrayBuffer();
  return new Response(buf, {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=3600" },
  });
}

// ---------- Auth & metering ----------

async function authenticate(request, env) {
  const key =
    request.headers.get("x-api-key") ||
    new URL(request.url).searchParams.get("key");

  if (!key) return { ok: false, error: "missing_api_key" };

  const cached = await env.API_KEYS.get(key, "json");
  if (cached) return { ok: true, keyRecord: cached };

  const row = await env.DB.prepare(
    "SELECT key, plan, status FROM api_keys WHERE key = ?"
  )
    .bind(key)
    .first();

  if (!row || row.status !== "active") {
    return { ok: false, error: "invalid_api_key" };
  }

  await env.API_KEYS.put(key, JSON.stringify(row), { expirationTtl: 300 });
  return { ok: true, keyRecord: row };
}

async function checkAndIncrementUsage(env, keyRecord) {
  const plan = PLANS[keyRecord.plan] || PLANS.free;
  const today = new Date().toISOString().slice(0, 10);
  const usageKey = `usage:${keyRecord.key}:${today}`;

  const current = parseInt((await env.API_KEYS.get(usageKey)) || "0", 10);
  if (current >= plan.dailyLimit) {
    return { ok: false, limit: plan.dailyLimit, resetAt: `${today}T23:59:59Z` };
  }

  await env.API_KEYS.put(usageKey, String(current + 1), { expirationTtl: 172800 });
  return { ok: true };
}

// ---------- Usage endpoint (read-only, no quota impact) ----------

/**
 * Returns current usage stats for the authenticated key.  Does NOT
 * increment the usage counter — this is a read-only peek.
 *
 * @param {object} env
 * @param {{ key: string, plan: string }} keyRecord
 * @returns {Promise<Response>}
 */
async function handleUsageRequest(env, keyRecord) {
  const plan = PLANS[keyRecord.plan] || PLANS.free;
  const today = new Date().toISOString().slice(0, 10);
  const usageKey = `usage:${keyRecord.key}:${today}`;

  const usedToday = parseInt((await env.API_KEYS.get(usageKey)) || "0", 10);

  return json({
    plan: keyRecord.plan,
    dailyLimit: plan.dailyLimit,
    usedToday,
    remaining: Math.max(0, plan.dailyLimit - usedToday),
    resetAt: `${today}T23:59:59Z`,
  });
}

// ---------- Lemon Squeezy provisioning ----------

async function handleLemonSqueezyWebhook(request, env, ctx) {
  const signature = request.headers.get("x-signature");
  const rawBody = await request.text();

  const valid = await verifyLemonSqueezySignature(
    rawBody,
    signature,
    env.LEMONSQUEEZY_WEBHOOK_SECRET
  );
  if (!valid) return json({ error: "invalid_signature" }, 401);

  const payload = JSON.parse(rawBody);
  const eventName = payload.meta?.event_name;
  const email = payload.data?.attributes?.user_email;
  const variantName = (payload.data?.attributes?.variant_name || "").toLowerCase();

  if (eventName === "order_created" || eventName === "subscription_created") {
    const plan = variantName.includes("pro")
      ? "pro"
      : variantName.includes("starter")
      ? "starter"
      : "free";

    const newKey = generateApiKey();
    await env.DB.prepare(
      "INSERT INTO api_keys (key, email, plan, status, created_at) VALUES (?, ?, ?, 'active', ?)"
    )
      .bind(newKey, email, plan, new Date().toISOString())
      .run();

    // Fire-and-forget: send purchase email via Brevo.  Key is already
    // provisioned in D1, so a Brevo failure must not break the webhook.
    ctx.waitUntil(sendPurchaseEmail(env, email, newKey, plan));

    return json({ ok: true, provisioned: true });
  }

  if (eventName === "subscription_cancelled" || eventName === "subscription_expired") {
    await env.DB.prepare("UPDATE api_keys SET status = 'inactive' WHERE email = ?")
      .bind(email)
      .run();
  }

  return json({ ok: true });
}

async function verifyLemonSqueezySignature(rawBody, signatureHeader, secret) {
  if (!secret || !signatureHeader) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(hex, signatureHeader);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

// ---------- Brevo transactional email ----------

/**
 * Sends a purchase-confirmation email with the new API key via Brevo's
 * transactional email API.  On failure, logs the error but does NOT throw —
 * the key is already persisted in D1 and must remain usable regardless.
 *
 * @param {object} env
 * @param {string} email
 * @param {string} apiKey
 * @param {string} plan
 */
async function sendPurchaseEmail(env, email, apiKey, plan) {
  if (!env.BREVO_API_KEY || !email) return;

  const baseUrl = env.WORKER_URL || "https://captureflare.workers.dev";
  const planLabel = PLANS[plan]?.name || plan;
  const dailyLimit = PLANS[plan]?.dailyLimit || 50;

  const htmlBody = [
    "<div style=\"font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1e293b;\">",
    "<h1 style=\"font-size:22px;margin:0 0 16px;\">Your Rendrly API key</h1>",
    "<p style=\"margin:0 0 12px;\">Thanks for subscribing to the <strong>", escapeHtml(planLabel), "</strong> plan ",
    "(", String(dailyLimit), " requests/day).</p>",
    "<p style=\"margin:0 0 24px;\"><code style=\"background:#f1f5f9;padding:8px 12px;border-radius:6px;font-size:14px;word-break:break-all;\">", escapeHtml(apiKey), "</code></p>",
    "<h2 style=\"font-size:16px;margin:0 0 8px;\">Quick start</h2>",
    "<pre style=\"background:#0f172a;color:#e2e8f0;padding:16px;border-radius:8px;font-size:13px;overflow-x:auto;\">", escapeHtml(`curl "${baseUrl}/v1/screenshot?url=https://example.com&key=${apiKey}" --output screenshot.png`), "</pre>",
    "<p style=\"margin:16px 0 0;\">Full docs: <a href=\"https://github.com/hardeyhemy/rendrly#readme\" style=\"color:#2563eb;\">github.com/hardeyhemy/rendrly</a></p>",
    "</div>",
  ].join("");

  try {
    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": env.BREVO_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sender: { name: "Rendrly", email: env.SENDER_EMAIL || "billings@revnuvo.site" },
        to: [{ email }],
        subject: "Your Rendrly API key",
        htmlContent: htmlBody,
      }),
    });
    if (!resp.ok) {
      console.error("Brevo email failed:", resp.status, await resp.text());
    }
  } catch (err) {
    console.error("Brevo email error:", err);
  }
}

// ---------- Admin (manual key minting before LS is wired up) ----------

async function handleAdminCreateKey(request, env) {
  const token = request.headers.get("x-admin-token");
  if (token !== env.ADMIN_TOKEN) return json({ error: "unauthorized" }, 401);

  const body = await request.json();
  const plan = PLANS[body.plan] ? body.plan : "free";
  const newKey = generateApiKey();

  await env.DB.prepare(
    "INSERT INTO api_keys (key, email, plan, status, created_at) VALUES (?, ?, ?, 'active', ?)"
  )
    .bind(newKey, body.email || null, plan, new Date().toISOString())
    .run();

  return json({ key: newKey, plan });
}

// ---------- SSRF guard ----------

/**
 * Returns true when `url` points to a blocked / internal target that must
 * never be fetched server-side (SSRF protection).
 *
 * @param {string} url
 * @returns {boolean}
 */
function isBlockedTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Not a valid URL at all — treat as blocked.
    return true;
  }

  // --- scheme: only http and https are allowed ----------------------------
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return true;
  }

  const hostname = parsed.hostname.toLowerCase();

  // --- literal loopback names --------------------------------------------
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "[::1]"
  ) {
    return true;
  }

  // --- blocked TLDs (.internal, .local) ----------------------------------
  if (hostname.endsWith(".internal") || hostname.endsWith(".local")) {
    return true;
  }

  // --- IPv4 address range checks -----------------------------------------
  // Match four decimal octets.  IPv6 is handled above via the literal
  // [::1] check; other IPv6 loopback/link-local forms (e.g. ::1, fe80::)
  // cannot appear as hostname in a URL without brackets, and bracketed
  // forms other than [::1] are let through here — acceptable for a minimal
  // gate.  Full IPv6 range checks can be added later if needed.
  const ipv4Match = hostname.match(
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
  );
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);

    // 169.254.x.x  — link-local / cloud instance metadata (AWS IMDS, etc.)
    if (a === 169 && b === 254) return true;

    // 10.x.x.x     — RFC 1918 Class A private
    if (a === 10) return true;

    // 172.16–31.x.x — RFC 1918 Class B private
    if (a === 172 && b >= 16 && b <= 31) return true;

    // 192.168.x.x  — RFC 1918 Class C private
    if (a === 192 && b === 168) return true;
  }

  return false;
}

// ---------- Helpers ----------

function generateApiKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, "");
  return `cf_${b64}`;
}

function clampInt(val, fallback, min, max) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
