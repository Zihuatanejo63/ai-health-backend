/**
 * Payment routes: create checkout session (bound to user), Creem webhook handler.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { requireSession } from "../lib/session";
import { AppError, jsonResponse, badRequest } from "../lib/errors";
import { logError, getClientHash } from "../lib/logger";
import type { CreateCheckoutRequest, CreateCheckoutResponse } from "../types";

interface Env {
  DB?: D1Database;
  CREEM_API_KEY?: string;
  CREEM_WEBHOOK_SECRET?: string;
  CREEM_ONE_TIME_REPORT_PRODUCT_ID?: string;
  CREEM_PLUS_MONTHLY_PRODUCT_ID?: string;
  CREEM_PLUS_YEARLY_PRODUCT_ID?: string;
  CREEM_API_BASE_URL?: string;
  FRONTEND_BASE_URL?: string;
}

const SUPPORTED_PLANS = ["one_time_report", "plus_monthly", "plus_yearly"] as const;

function requireDb(env: Env): D1Database {
  if (!env.DB) throw new AppError(500, "db_unavailable", "Database is not configured.");
  return env.DB;
}

function getProductId(plan: string, env: Env): string {
  switch (plan) {
    case "one_time_report": return env.CREEM_ONE_TIME_REPORT_PRODUCT_ID || "";
    case "plus_yearly": return env.CREEM_PLUS_YEARLY_PRODUCT_ID || "";
    case "plus_monthly": return env.CREEM_PLUS_MONTHLY_PRODUCT_ID || "";
    default: return "";
  }
}

// ---- Create Checkout ----

export async function handleCreateCheckout(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    throw new AppError(405, "method_not_allowed", "Use POST for this endpoint.");
  }

  const db = requireDb(env);

  let body: CreateCheckoutRequest;
  try {
    body = (await request.json()) as CreateCheckoutRequest;
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }

  if (!body.plan || !SUPPORTED_PLANS.includes(body.plan)) {
    throw badRequest(`Invalid plan. Must be one of: ${SUPPORTED_PLANS.join(", ")}`);
  }

  // All paid plans require login so webhooks can bind entitlements to a user
  const session = await requireSession(db, request.headers.get("Cookie"));

  if (!env.CREEM_API_KEY) {
    throw new AppError(500, "config_error", "Payment provider is not configured.");
  }

  const productId = getProductId(body.plan, env);
  if (!productId) {
    throw new AppError(500, "config_error", `No product configured for plan: ${body.plan}`);
  }

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
      product_id: productId,
      request_id: requestId,
      success_url: `${appUrl}/payment-success?plan=${encodeURIComponent(body.plan)}`,
      metadata: {
        plan: body.plan,
        userId: session?.user.id || "",
        userEmail: session?.user.email || "",
      },
    }),
  });

  const data = (await creemResponse.json().catch(() => ({}))) as {
    id?: string; checkout_url?: string; checkoutUrl?: string; url?: string; error?: string;
  };

  if (!creemResponse.ok) {
    if (env.DB) {
      await logError(env.DB, {
        eventType: "checkout_create_failed",
        route: "/api/create-checkout-session",
        method: "POST",
        status: creemResponse.status,
        clientHash: await getClientHash(request),
        message: data.error || `Creem API returned ${creemResponse.status}`,
      });
    }
    throw new AppError(502, "checkout_error", data.error || "Checkout creation failed.");
  }

  const checkoutUrl = data.checkout_url || data.checkoutUrl || data.url;
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
    throw new AppError(502, "checkout_error", "Missing checkout URL from payment provider.");
  }

  // Track checkout session
  const checkoutSessionId = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO checkout_sessions (id, user_id, plan, provider, provider_checkout_id, status, created_at, updated_at)
     VALUES (?, ?, ?, 'creem', ?, 'pending', ?, ?)`
  ).bind(checkoutSessionId, session.user.id, body.plan, data.id || requestId, new Date().toISOString(), new Date().toISOString()).run();

  const response: CreateCheckoutResponse = {
    checkoutUrl,
    checkoutSessionId: data.id || requestId,
  };

  return jsonResponse(response);
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

  const entitlementPlan = plan === "plus_monthly" || plan === "plus_yearly" ? "plus" : plan;

  switch (eventType) {
    case "checkout.completed":
    case "payment.completed": {
      if (entitlementPlan === "one_time_report") {
        await upsertEntitlement(db, userId, "one_time_report", "active", customerId, eventId, subscriptionId);
      }
      break;
    }
    case "subscription.active":
    case "subscription.paid": {
      await upsertEntitlement(db, userId, "plus", "active", customerId, eventId, subscriptionId);
      break;
    }
    case "subscription.canceled":
    case "subscription.expired":
    case "subscription.paused": {
      await updateEntitlementStatus(db, userId, "plus", "cancelled");
      break;
    }
    case "refund.created": {
      await updateEntitlementStatus(db, userId, entitlementPlan, "refunded");
      break;
    }
    case "dispute.created":
    case "chargeback.created": {
      await updateEntitlementStatus(db, userId, entitlementPlan, "chargeback");
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
  db: D1Database, userId: string, plan: string, status: string,
  customerId: string, checkoutId: string, subscriptionId: string
): Promise<void> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  const existing = await db.prepare(
    "SELECT id FROM entitlements WHERE user_id = ? AND plan = ?"
  ).bind(userId, plan).first<{ id: string }>();

  if (existing) {
    await db.prepare(
      `UPDATE entitlements SET status = ?, creem_customer_id = ?, creem_checkout_id = ?,
       creem_subscription_id = ?, updated_at = ? WHERE id = ?`
    ).bind(status, customerId, checkoutId, subscriptionId, now, existing.id).run();
  } else {
    await db.prepare(
      `INSERT INTO entitlements (id, user_id, plan, status, provider, creem_customer_id, creem_checkout_id, creem_subscription_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'creem', ?, ?, ?, ?, ?)`
    ).bind(id, userId, plan, status, customerId, checkoutId, subscriptionId, now, now).run();
  }
}

async function updateEntitlementStatus(
  db: D1Database, userId: string, plan: string, status: string
): Promise<void> {
  await db.prepare(
    "UPDATE entitlements SET status = ?, updated_at = ? WHERE user_id = ? AND plan = ?"
  ).bind(status, new Date().toISOString(), userId, plan).run();
}
