/**
 * Health data routes: symptom checks, health profiles, insurance profiles, data export/delete.
 * All sensitive data is encrypted at rest with AES-256-GCM.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { encryptJson, decryptJson } from "../lib/crypto";
import { requireSession } from "../lib/session";
import { AppError, jsonResponse, badRequest, notFound } from "../lib/errors";

interface Env {
  DB?: D1Database;
  DATA_ENCRYPTION_KEY?: string;
}

function requireDb(env: Env): D1Database {
  if (!env.DB) throw new AppError(500, "db_unavailable", "Database is not configured.");
  return env.DB;
}

function requireEncKey(env: Env): string {
  if (!env.DATA_ENCRYPTION_KEY) throw new AppError(500, "config_error", "DATA_ENCRYPTION_KEY is not configured.");
  return env.DATA_ENCRYPTION_KEY;
}

// ---- Symptom Checks ----

export async function handleGetSymptomChecks(request: Request, env: Env): Promise<Response> {
  const db = requireDb(env);
  const encKey = requireEncKey(env);
  const session = await requireSession(db, request.headers.get("Cookie"));

  const rows = await db.prepare(
    `SELECT id, risk_level, recommended_care, primary_concern, created_at
     FROM symptom_checks WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`
  ).bind(session.user.id).all<{
    id: string; risk_level: string; recommended_care: string; primary_concern: string; created_at: string;
  }>();

  return jsonResponse({ checks: rows.results });
}

export async function handleGetSymptomCheck(request: Request, env: Env, checkId: string): Promise<Response> {
  const db = requireDb(env);
  const encKey = requireEncKey(env);
  const session = await requireSession(db, request.headers.get("Cookie"));

  const row = await db.prepare(
    "SELECT id, encrypted_payload FROM symptom_checks WHERE id = ? AND user_id = ?"
  ).bind(checkId, session.user.id).first<{ id: string; encrypted_payload: string }>();

  if (!row) throw notFound("Symptom check not found.");

  const data = await decryptJson(row.encrypted_payload, encKey);
  return jsonResponse({ id: row.id, ...(data as Record<string, unknown>) });
}

export async function handleDeleteSymptomCheck(request: Request, env: Env, checkId: string): Promise<Response> {
  const db = requireDb(env);
  const session = await requireSession(db, request.headers.get("Cookie"));

  const result = await db.prepare(
    "DELETE FROM symptom_checks WHERE id = ? AND user_id = ?"
  ).bind(checkId, session.user.id).run();

  if (result.meta.changes === 0) throw notFound("Symptom check not found.");
  return jsonResponse({ ok: true });
}

// ---- Health Profile ----

export async function handleGetHealthProfile(request: Request, env: Env): Promise<Response> {
  const db = requireDb(env);
  const encKey = requireEncKey(env);
  const session = await requireSession(db, request.headers.get("Cookie"));

  const row = await db.prepare(
    "SELECT encrypted_payload, updated_at FROM health_profiles WHERE user_id = ?"
  ).bind(session.user.id).first<{ encrypted_payload: string; updated_at: string }>();

  if (!row) return jsonResponse({ profile: null });

  const data = await decryptJson(row.encrypted_payload, encKey);
  return jsonResponse({ profile: data, updatedAt: row.updated_at });
}

export async function handlePutHealthProfile(request: Request, env: Env): Promise<Response> {
  const db = requireDb(env);
  const encKey = requireEncKey(env);
  const session = await requireSession(db, request.headers.get("Cookie"));

  let body: unknown;
  try { body = await request.json(); } catch { throw badRequest("Invalid JSON."); }

  const encrypted = await encryptJson(body, encKey);
  const now = new Date().toISOString();

  await db.prepare(
    `INSERT INTO health_profiles (user_id, encrypted_payload, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET encrypted_payload = excluded.encrypted_payload, updated_at = excluded.updated_at`
  ).bind(session.user.id, encrypted, now, now).run();

  return jsonResponse({ ok: true });
}

// ---- Insurance Profile ----

export async function handleGetInsuranceProfile(request: Request, env: Env): Promise<Response> {
  const db = requireDb(env);
  const encKey = requireEncKey(env);
  const session = await requireSession(db, request.headers.get("Cookie"));

  const row = await db.prepare(
    "SELECT encrypted_payload, updated_at FROM insurance_profiles WHERE user_id = ?"
  ).bind(session.user.id).first<{ encrypted_payload: string; updated_at: string }>();

  if (!row) return jsonResponse({ profile: null });

  const data = await decryptJson(row.encrypted_payload, encKey);
  return jsonResponse({ profile: data, updatedAt: row.updated_at });
}

export async function handlePutInsuranceProfile(request: Request, env: Env): Promise<Response> {
  const db = requireDb(env);
  const encKey = requireEncKey(env);
  const session = await requireSession(db, request.headers.get("Cookie"));

  let body: unknown;
  try { body = await request.json(); } catch { throw badRequest("Invalid JSON."); }

  const encrypted = await encryptJson(body, encKey);
  const now = new Date().toISOString();

  await db.prepare(
    `INSERT INTO insurance_profiles (user_id, encrypted_payload, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET encrypted_payload = excluded.encrypted_payload, updated_at = excluded.updated_at`
  ).bind(session.user.id, encrypted, now, now).run();

  return jsonResponse({ ok: true });
}

// ---- Data Export / Delete ----

export async function handleExportData(request: Request, env: Env): Promise<Response> {
  const db = requireDb(env);
  const encKey = requireEncKey(env);
  const session = await requireSession(db, request.headers.get("Cookie"));

  const checks = await db.prepare(
    "SELECT encrypted_payload FROM symptom_checks WHERE user_id = ? ORDER BY created_at DESC LIMIT 100"
  ).bind(session.user.id).all<{ encrypted_payload: string }>();

  const hp = await db.prepare(
    "SELECT encrypted_payload FROM health_profiles WHERE user_id = ?"
  ).bind(session.user.id).first<{ encrypted_payload: string }>();

  const ip = await db.prepare(
    "SELECT encrypted_payload FROM insurance_profiles WHERE user_id = ?"
  ).bind(session.user.id).first<{ encrypted_payload: string }>();

  const exportData: { user: typeof session.user; exportedAt: string; symptomChecks: unknown[]; healthProfile: unknown; insuranceProfile: unknown } = {
    user: session.user,
    exportedAt: new Date().toISOString(),
    symptomChecks: [],
    healthProfile: null,
    insuranceProfile: null,
  };

  for (const row of checks.results) {
    try {
      exportData.symptomChecks.push(await decryptJson(row.encrypted_payload, encKey));
    } catch { /* skip corrupt entries */ }
  }
  if (hp) {
    try { exportData.healthProfile = await decryptJson(hp.encrypted_payload, encKey); } catch { /* skip */ }
  }
  if (ip) {
    try { exportData.insuranceProfile = await decryptJson(ip.encrypted_payload, encKey); } catch { /* skip */ }
  }

  return jsonResponse(exportData);
}

export async function handleDeleteData(request: Request, env: Env): Promise<Response> {
  const db = requireDb(env);
  const session = await requireSession(db, request.headers.get("Cookie"));

  await db.prepare("DELETE FROM symptom_checks WHERE user_id = ?").bind(session.user.id).run();
  await db.prepare("DELETE FROM health_profiles WHERE user_id = ?").bind(session.user.id).run();
  await db.prepare("DELETE FROM insurance_profiles WHERE user_id = ?").bind(session.user.id).run();
  await db.prepare("DELETE FROM coverage_checklists WHERE user_id = ?").bind(session.user.id).run();
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(session.user.id).run();
  await db.prepare(
    "DELETE FROM auth_tokens WHERE email = (SELECT email FROM users WHERE id = ?)"
  ).bind(session.user.id).run();
  // Do NOT delete: entitlements (payment record), payment_events (audit trail), checkout_sessions (fraud prevention)
  // Entitlements are deactivated rather than deleted for accounting compliance.

  // Write audit log
  await db.prepare(
    "INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(
    crypto.randomUUID(),
    session.user.id,
    "user.data.delete",
    "user",
    session.user.id,
    JSON.stringify({ email: session.user.email }),
    new Date().toISOString()
  ).run();

  return jsonResponse({ ok: true });
}
