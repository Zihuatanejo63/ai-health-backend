/**
 * Payment routes: create checkout session (bound to user), Creem webhook handler.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { requireSession } from "../lib/session";
import { AppError, jsonResponse, badRequest } from "../lib/errors";
import { logError, getClientHash } from "../lib/logger";
import type { CreateCheckoutRequest } from "../types";

interface Env {
  DB?: D1Database;
  CREEM_API_KEY?: string;
  CREEM_WEBHOOK_SECRET?: string;
  CREEM_PLUS_MONTHLY_PRODUCT_ID?: string;
  CREEM_API_BASE_URL?: string;
  FRONTEND_BASE_URL?: string;
}

const SUPPORTED_PLANS = ["plus_monthly"] as const;

function requireDb(env: Env): D1Database {
  if (!env.DB) throw new AppError(500, "db_unavailable", "Database is not configured.");
  return env.DB;
}

// ---- Create Checkout ----

export async function handleCreateCheckout(request: Request, env: Env): Promise<Response> {
  try {
    if (request.method !== "POST") {
      return jsonResponse({ ok: false, code: "method_not_allowed", message: "Use POST for this endpoint." }, 405);
    }

    const db = requireDb(env);

    let body: CreateCheckoutRequest;
    try {
      body = (await request.json()) as CreateCheckoutRequest;
    } catch {
      return jsonResponse({ ok: false, code: "bad_request", message: "Request body must be valid JSON." }, 400);
    }

    if (!body.plan || !SUPPORTED_PLANS.includes(body.plan)) {
      return jsonResponse({ ok: false, code: "UNSUPPORTED_PLAN", message: "Unsupported plan." }, 400);
    }

    // All paid plans require login so webhooks can bind entitlements to a user
    const session = await requireSession(db, request.headers.get("Cookie"));

    if (!env.CREEM_API_KEY) {
      return jsonResponse({ ok: false, code: "CREEM_API_KEY_NOT_CONFIGURED", message: "Creem API key is not configured." }, 500);
    }

    const plusMonthlyProductId = env.CREEM_PLUS_MONTHLY_PRODUCT_ID || "";
    if (!plusMonthlyProductId) {
      return jsonResponse({ ok: false, code: "CREEM_PRODUCT_NOT_CONFIGURED", message: "Creem Plus monthly product is not configured." }, 500);
    }

    console.log("[creem] create checkout", {
      planId: body.plan,
      productId: plusMonthlyProductId,
    });

    const creemBaseUrl = (env.CREEM_API_BASE_URL || "https://api.creem.io").replace(/\/$/, "");
    const appUrl = (env.FRONTEND_BASE_URL || "https://healthmatchai.com").replace(/\/$/, "");
    const requestId = `hm_${body.plan}_${crypto.randomUUID()}`;

    const creemResponse = await fetch(`${creemBaseUrl}/v1/checkouts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.CREEM_API_KEY,
      },
      body: JSON.stringify({
        product_id: plusMonthlyProductId,
        request_id: requestId,
        success_url: `${appUrl}/payment-success?plan=${encodeURIComponent(body.plan)}`,
        metadata: {
          plan: body.plan,
          userId: session?.user.id || "",
          userEmail: session?.user.email || "",
        },
      }),
    });

    const creemResponseText = await creemResponse.text().catch(() => "");
    let creemData: Record<string, unknown> = {};
    try { creemData = JSON.parse(creemResponseText) as Record<string, unknown>; } catch { /* not JSON */ }

    if (!creemResponse.ok) {
      console.log("[creem] checkout failed", {
        planId: body.plan,
        productIdConfigured: !!plusMonthlyProductId,
        apiKeyConfigured: !!env.CREEM_API_KEY,
        creemStatus: creemResponse.status,
        creemResponse: creemResponseText,
      });

      if (env.DB) {
        await logError(env.DB, {
          eventType: "checkout_create_failed",
          route: "/api/create-checkout-session",
          method: "POST",
          status: creemResponse.status,
          clientHash: await getClientHash(request),
          message: String(creemData.error || creemData.message || `Creem API returned ${creemResponse.status}`),
        });
      }

      let message = `Creem returned ${creemResponse.status}.`;
      const lower = creemResponseText.toLowerCase();
      if (creemResponse.status === 401 || creemResponse.status === 403) {
        message = "Creem API key or account review is not ready.";
      } else if (lower.includes("account") || lower.includes("store") || lower.includes("merchant") ||
                 lower.includes("onboarding") || lower.includes("verification") || lower.includes("review") ||
                 lower.includes("not approved")) {
        message = "Creem account review is not completed yet.";
      }

      return jsonResponse({
        ok: false,
        code: "CREEM_CHECKOUT_FAILED",
        message,
      }, 500);
    }

    const checkoutUrl = (creemData.checkout_url || creemData.checkoutUrl || creemData.url) as string | undefined;
    if (!checkoutUrl) {
      if (env.DB) {
        await logError(env.DB, {
          eventType: "checkout_create_failed",
          route: "/api/create-checkout-session",
          method: "POST",
          status: 502,
          clientHash: await getClientHash(request),
          message: "Missing checkout URL from Creem response",
        });
      }
      return jsonResponse({ ok: false, code: "checkout_error", message: "Missing checkout URL from payment provider." }, 502);
    }

    // Track checkout session
    const checkoutSessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO checkout_sessions (id, user_id, plan_id, product_id, provider, provider_checkout_id, checkout_url, status, amount, currency, raw_response, created_at, updated_at)
       VALUES (?, ?, 'plus_monthly', ?, 'creem', ?, ?, 'pending', ?, ?, ?, ?, ?)`
    ).bind(
      checkoutSessionId,
      session.user.id,
      plusMonthlyProductId,
      (creemData.id as string) || requestId,
      checkoutUrl,
      (creemData.amount as number) ?? null,
      (creemData.currency as string) || "usd",
      creemResponseText,
      now,
      now
    ).run();

    return jsonResponse({
      ok: true,
      checkoutUrl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[creem] checkout unhandled error", {
      message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    const errLike = error as { status?: unknown; code?: unknown };
    const status = error instanceof AppError
      ? error.status
      : typeof errLike.status === "number" ? errLike.status : 500;
    const code = error instanceof AppError
      ? error.code
      : typeof errLike.code === "string" ? errLike.code : "CHECKOUT_FAILED";
    return jsonResponse({
      ok: false,
      code,
      message: status >= 500 ? "Checkout failed. Please try again later." : message,
    }, status);
  }
}

// ---- Checkout configuration status ----

export async function handleCheckoutStatus(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return jsonResponse({ ok: false, code: "method_not_allowed", message: "Use GET for this endpoint." }, 405);
  }
  const configured = Boolean(env.CREEM_API_KEY && env.CREEM_PLUS_MONTHLY_PRODUCT_ID);
  return jsonResponse({ configured });
}

// ---- Creem Webhook ----

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export async function verifyCreemSignature(rawBody: string, signature: string, secret: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return timingSafeEqual(toHex(sig), signature);
}

type CreemWebhookEvent = {
  id?: string;
  eventType?: string;
  type?: string;
  object?: {
    id?: string;
    customer?: { id?: string };
    customer_id?: string;
    subscription?: { id?: string };
    subscription_id?: string;
    metadata?: Record<string, unknown>;
    status?: string;
  };
};

export async function handleCreemWebhook(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    throw new AppError(405, "method_not_allowed", "Use POST for this endpoint.");
  }

  if (!env.CREEM_WEBHOOK_SECRET) {
    throw new AppError(500, "config_error", "CREEM_WEBHOOK_SECRET is not configured.");
  }

  const db = requireDb(env);
  const signature = request.headers.get("creem-signature");
  if (!signature) {
    throw new AppError(401, "unauthorized", "Missing Creem signature.");
  }

  const rawBody = await request.text();

  const verified = await verifyCreemSignature(rawBody, signature, env.CREEM_WEBHOOK_SECRET);
  if (!verified) {
    await logError(db, {
      eventType: "creem_webhook_invalid_signature",
      route: "/api/webhooks/creem",
      method: "POST",
      status: 401,
      clientHash: await getClientHash(request),
      message: "Creem signature verification failed",
    });
    throw new AppError(401, "unauthorized", "Invalid Creem signature.");
  }

  let event: CreemWebhookEvent;
  try {
    event = JSON.parse(rawBody) as CreemWebhookEvent;
  } catch {
    throw badRequest("Invalid webhook payload.");
  }

  const eventId = event.id || crypto.randomUUID();
  const eventType = event.eventType || event.type || "unknown";

  // Idempotency check
  const existing = await db.prepare(
    "SELECT id FROM payment_events WHERE event_id = ?"
  ).bind(eventId).first<{ id: string }>();

  if (existing) {
    return jsonResponse({ received: true, deduplicated: true });
  }

  // Record the event first
  await db.prepare(
    "INSERT INTO payment_events (id, provider, event_id, event_type, payload, processed_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(crypto.randomUUID(), "creem", eventId, eventType, rawBody, new Date().toISOString()).run();

  // Process entitlement updates
  const obj = event.object || {};
  const metadata = (obj.metadata || {}) as Record<string, unknown>;
  const userId = String(metadata.userId || "");
  const plan = String(metadata.plan || "");
  const customerId = obj.customer?.id || obj.customer_id || "";
  const subscriptionId = obj.subscription?.id || obj.subscription_id || "";

  if (!userId) {
    console.warn("Creem webhook received without userId in metadata. Event:", eventId, eventType);
    return jsonResponse({ received: true, warning: "no_user_id" });
  }

  switch (eventType) {
    case "subscription.active":
    case "subscription.paid": {
      await upsertEntitlement(db, userId, "plus_monthly", "active", customerId, eventId, subscriptionId);
      break;
    }
    case "subscription.canceled":
    case "subscription.expired":
    case "subscription.paused": {
      await updateEntitlementStatus(db, userId, "plus_monthly", "cancelled");
      break;
    }
    case "refund.created": {
      await updateEntitlementStatus(db, userId, "plus_monthly", "refunded");
      break;
    }
    case "dispute.created":
    case "chargeback.created": {
      await updateEntitlementStatus(db, userId, "plus_monthly", "chargeback");
      break;
    }
    default:
      console.info("Unhandled Creem event type:", eventType, "eventId:", eventId);
  }

  // Update checkout session status
  if (eventType === "checkout.completed") {
    await db.prepare(
      "UPDATE checkout_sessions SET status = 'completed', updated_at = ? WHERE provider_checkout_id = ?"
    ).bind(new Date().toISOString(), eventId).run();
  }

  return jsonResponse({ received: true });
}

async function upsertEntitlement(
  db: D1Database, userId: string, planId: string, status: string,
  customerId: string, checkoutId: string, subscriptionId: string
): Promise<void> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const existing = await db.prepare(
    "SELECT id FROM entitlements WHERE user_id = ? AND plan_id = ?"
  ).bind(userId, planId).first<{ id: string }>();

  if (existing) {
    await db.prepare(
      `UPDATE entitlements SET status = ?, provider_customer_id = ?, provider_checkout_id = ?,
       provider_subscription_id = ?, updated_at = ? WHERE id = ?`
    ).bind(status, customerId, checkoutId, subscriptionId, now, existing.id).run();
  } else {
    await db.prepare(
      `INSERT INTO entitlements (id, user_id, plan_id, product_id, status, provider, provider_customer_id, provider_checkout_id, provider_subscription_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'creem', ?, ?, ?, ?, ?)`
    ).bind(id, userId, planId, planId, status, customerId, checkoutId, subscriptionId, now, now).run();
  }
}

async function updateEntitlementStatus(
  db: D1Database, userId: string, planId: string, status: string
): Promise<void> {
  await db.prepare(
    "UPDATE entitlements SET status = ?, updated_at = ? WHERE user_id = ? AND plan_id = ?"
  ).bind(status, new Date().toISOString(), userId, planId).run();
}
