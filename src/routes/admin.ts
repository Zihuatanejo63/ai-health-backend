/**
 * Admin routes: dashboard, user lookup, ledger management.
 * Auth: session cookie with role=admin first, then Bearer ADMIN_API_TOKEN fallback.
 * Never returns: health data plaintext, encrypted_payload, Gemini content, API keys.
 * All admin operations write audit logs.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { verifyAndGetSession } from "../lib/session";
import { AppError, jsonResponse, badRequest, notFound } from "../lib/errors";

interface Env {
  DB?: D1Database;
  ADMIN_API_TOKEN?: string;
}

function requireDb(env: Env): D1Database {
  if (!env.DB) throw new AppError(500, "db_unavailable", "Database is not configured.");
  return env.DB;
}

async function writeAuditLog(
  db: D1Database,
  actorUserId: string | null,
  action: string,
  targetType?: string,
  targetId?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await db.prepare(
    "INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    crypto.randomUUID(),
    actorUserId,
    action,
    targetType || null,
    targetId || null,
    metadata ? JSON.stringify(metadata) : null,
    new Date().toISOString()
  ).run();
}

async function authenticateAdmin(request: Request, env: Env): Promise<{ userId: string | null }> {
  // Method 1: Session cookie with admin role (preferred)
  if (env.DB) {
    const session = await verifyAndGetSession(env.DB, request.headers.get("Cookie"));
    if (session && session.user.role === "admin") return { userId: session.user.id };
  }

  // Method 2: Bearer token (fallback for API access)
  if (env.ADMIN_API_TOKEN) {
    const expected = `Bearer ${env.ADMIN_API_TOKEN}`;
    if (request.headers.get("Authorization") === expected) return { userId: null };
  }

  throw new AppError(401, "unauthorized", "Admin access required.");
}

// ---- Dashboard ----

export async function handleAdminDashboard(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    throw new AppError(405, "method_not_allowed", "Use GET for this endpoint.");
  }
  const { userId } = await authenticateAdmin(request, env);
  const db = requireDb(env);

  const [usersCount, symptomChecksCount, entitlementsCount, paymentEventsCount, webhookFailures, recentErrors] =
    await Promise.all([
      db.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>(),
      db.prepare("SELECT COUNT(*) AS count FROM symptom_checks").first<{ count: number }>(),
      db.prepare("SELECT COUNT(*) AS count FROM entitlements WHERE status = 'active'").first<{ count: number }>(),
      db.prepare("SELECT COUNT(*) AS count FROM payment_events").first<{ count: number }>(),
      db.prepare(
        "SELECT event_type, COUNT(*) AS count FROM error_logs WHERE event_type LIKE 'creem_webhook%' GROUP BY event_type ORDER BY count DESC"
      ).all<{ event_type: string; count: number }>(),
      db.prepare(
        "SELECT event_type, route, message, created_at FROM error_logs ORDER BY created_at DESC LIMIT 20"
      ).all<{ event_type: string; route: string; message: string; created_at: string }>(),
    ]);

  await writeAuditLog(db, userId, "admin.dashboard.view");

  return jsonResponse({
    counts: {
      users: usersCount?.count ?? 0,
      symptomChecks: symptomChecksCount?.count ?? 0,
      activeEntitlements: entitlementsCount?.count ?? 0,
      paymentEvents: paymentEventsCount?.count ?? 0,
    },
    webhookFailures: webhookFailures.results,
    recentErrors: recentErrors.results,
  });
}

// ---- User Lookup ----

export async function handleAdminUserLookup(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    throw new AppError(405, "method_not_allowed", "Use GET for this endpoint.");
  }
  const { userId: actorId } = await authenticateAdmin(request, env);
  const db = requireDb(env);

  const url = new URL(request.url);
  const identifier = (url.searchParams.get("email") || url.searchParams.get("userId") || "").trim();
  if (!identifier) {
    throw badRequest("Provide ?email= or ?userId= query parameter.");
  }

  const user = await db.prepare(
    "SELECT id, email, display_name as name, 'user' as role, created_at FROM users WHERE email = ? OR id = ? LIMIT 1"
  ).bind(identifier, identifier).first<{
    id: string; email: string; name: string; role: string; created_at: string;
  }>();

  if (!user) throw notFound("User not found.");

  const [entitlements, checkoutSessions, paymentEvents, symptomCheckCount] = await Promise.all([
    db.prepare(
      "SELECT plan, status, provider, creem_checkout_id, creem_subscription_id, current_period_end, created_at, updated_at FROM entitlements WHERE user_id = ? ORDER BY created_at DESC"
    ).bind(user.id).all(),
    db.prepare(
      "SELECT id, plan, status, created_at FROM checkout_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 10"
    ).bind(user.id).all(),
    db.prepare(
      "SELECT event_type, created_at FROM payment_events WHERE payload LIKE ? ORDER BY created_at DESC LIMIT 10"
    ).bind(`%${user.id}%`).all(),
    db.prepare(
      "SELECT COUNT(*) AS count FROM symptom_checks WHERE user_id = ?"
    ).bind(user.id).first<{ count: number }>(),
  ]);

  await writeAuditLog(db, actorId, "admin.user.lookup", "user", user.id, { lookupBy: identifier.includes("@") ? "email" : "userId" });

  return jsonResponse({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      createdAt: user.created_at,
    },
    entitlements: entitlements.results,
    checkoutSessions: checkoutSessions.results,
    paymentEvents: paymentEvents.results,
    symptomCheckCount: symptomCheckCount?.count ?? 0,
    // Never include: encrypted_payload, health data plaintext, Gemini content
  });
}

// ---- Entitlements List ----

export async function handleAdminEntitlements(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    throw new AppError(405, "method_not_allowed", "Use GET for this endpoint.");
  }
  const { userId } = await authenticateAdmin(request, env);
  const db = requireDb(env);

  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "active";
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 100);

  const rows = await db.prepare(
    `SELECT e.id, e.user_id, u.email, e.plan, e.status, e.provider, e.current_period_end, e.created_at
     FROM entitlements e
     LEFT JOIN users u ON u.id = e.user_id
     WHERE e.status = ?
     ORDER BY e.created_at DESC LIMIT ?`
  ).bind(status, limit).all<{
    id: string; user_id: string; email: string; plan: string; status: string; provider: string; current_period_end: string; created_at: string;
  }>();

  await writeAuditLog(db, userId, "admin.entitlements.list", undefined, undefined, { status, limit });

  return jsonResponse({ entitlements: rows.results });
}

// ---- Ledger (legacy) ----

export async function handleAdminLedger(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    throw new AppError(405, "method_not_allowed", "Use GET for this endpoint.");
  }
  const { userId } = await authenticateAdmin(request, env);
  const db = requireDb(env);

  const url = new URL(request.url);
  const payoutStatus = url.searchParams.get("payoutStatus");
  const allowedStatuses = new Set(["pending", "paid", "cancelled"]);
  const filter = payoutStatus && allowedStatuses.has(payoutStatus) ? payoutStatus : null;

  const orders = filter
    ? await db.prepare(
        `SELECT o.id, o.case_reference_id, o.gross_amount_usd, o.platform_fee_rate_bps,
                o.platform_fee_usd, o.doctor_payout_usd, o.status, o.service_status,
                o.payout_status, o.payout_method, o.payout_reference, o.paid_out_at, o.created_at
         FROM orders o WHERE o.payout_status = ? ORDER BY o.id DESC LIMIT 100`
      ).bind(filter).all()
    : await db.prepare(
        `SELECT o.id, o.case_reference_id, o.gross_amount_usd, o.platform_fee_rate_bps,
                o.platform_fee_usd, o.doctor_payout_usd, o.status, o.service_status,
                o.payout_status, o.payout_method, o.payout_reference, o.paid_out_at, o.created_at
         FROM orders o ORDER BY o.id DESC LIMIT 100`
      ).all();

  const totals = await db.prepare(
    `SELECT COALESCE(SUM(gross_amount_usd), 0) AS gross_amount_usd,
            COALESCE(SUM(platform_fee_usd), 0) AS platform_fee_usd,
            COALESCE(SUM(doctor_payout_usd), 0) AS doctor_payout_usd,
            COALESCE(SUM(CASE WHEN payout_status = 'pending' THEN doctor_payout_usd ELSE 0 END), 0) AS pending_doctor_payout_usd,
            COALESCE(SUM(CASE WHEN payout_status = 'paid' THEN doctor_payout_usd ELSE 0 END), 0) AS paid_doctor_payout_usd
     FROM orders`
  ).first();

  return jsonResponse({ totals, orders: orders.results });
}

export async function handleAdminMarkPayout(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    throw new AppError(405, "method_not_allowed", "Use POST for this endpoint.");
  }
  const { userId } = await authenticateAdmin(request, env);
  const db = requireDb(env);

  let body: { orderId?: number; payoutMethod?: string; payoutReference?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }

  if (!body.orderId || !Number.isInteger(body.orderId) || body.orderId <= 0) {
    throw badRequest("orderId must be a positive integer.");
  }

  const result = await db.prepare(
    `UPDATE orders SET payout_status = 'paid', payout_method = ?, payout_reference = ?,
     paid_out_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(body.payoutMethod || "manual", body.payoutReference || null, body.orderId).run();

  if (result.meta.changes === 0) throw new AppError(404, "not_found", "Order not found.");

  await writeAuditLog(db, userId, "admin.ledger.mark_payout", "order", String(body.orderId), {
    payoutMethod: body.payoutMethod || "manual",
    payoutReference: body.payoutReference || null,
  });

  await db.prepare(
    "INSERT INTO ledger_events (order_id, event_type, metadata) VALUES (?, ?, ?)"
  ).bind(body.orderId, "doctor_payout_marked_paid", JSON.stringify({
    payoutMethod: body.payoutMethod || "manual",
    payoutReference: body.payoutReference || null,
  })).run();

  return jsonResponse({ ok: true });
}
