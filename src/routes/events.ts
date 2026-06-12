/**
 * First-party funnel events and email capture.
 *
 * Privacy rules:
 * - Events accept only an allowlisted type plus a short label. No IP, no
 *   user agent, no symptom data is stored.
 * - Subscribers stores the email address only.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { AppError, jsonResponse, badRequest } from "../lib/errors";

interface Env {
  DB?: D1Database;
}

const EVENT_TYPES = new Set([
  "result_viewed",
  "partner_click",
  "report_print",
  "check_started",
]);

const MAX_LABEL_LENGTH = 64;

function requireDb(env: Env): D1Database {
  if (!env.DB) throw new AppError(500, "db_unavailable", "Database is not configured.");
  return env.DB;
}

export async function handleTrackEvent(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    throw new AppError(405, "method_not_allowed", "Use POST for this endpoint.");
  }

  let body: { type?: string; label?: string };
  try {
    body = (await request.json()) as { type?: string; label?: string };
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }

  const type = String(body.type || "");
  if (!EVENT_TYPES.has(type)) {
    throw badRequest("Unknown event type.");
  }

  const label = body.label ? String(body.label).slice(0, MAX_LABEL_LENGTH) : null;
  const db = requireDb(env);

  await db.prepare(
    "INSERT INTO events (id, type, label, created_at) VALUES (?, ?, ?, ?)"
  ).bind(crypto.randomUUID(), type, label, new Date().toISOString()).run();

  return jsonResponse({ ok: true });
}

export async function handleSubscribe(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    throw new AppError(405, "method_not_allowed", "Use POST for this endpoint.");
  }

  let body: { email?: string; source?: string };
  try {
    body = (await request.json()) as { email?: string; source?: string };
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }

  const email = (body.email || "").trim().toLowerCase();
  if (!email || !email.includes("@") || email.length > 254) {
    throw badRequest("A valid email address is required.");
  }

  const source = body.source ? String(body.source).slice(0, 32) : null;
  const db = requireDb(env);

  await db.prepare(
    "INSERT INTO subscribers (id, email, source, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO NOTHING"
  ).bind(crypto.randomUUID(), email, source, new Date().toISOString()).run();

  // Always succeed — do not reveal whether the email was already subscribed.
  return jsonResponse({ ok: true, message: "Subscribed." });
}
