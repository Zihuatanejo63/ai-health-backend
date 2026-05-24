/**
 * Auth routes: magic link request, verify, logout, /api/me.
 * Email+password: register, login.
 * Rate limits: 1 request per email per minute, max per IP per hour.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { createSession, destroySession, verifyAndGetSession } from "../lib/session";
import { sendMagicLink } from "../lib/email";
import { AppError, jsonResponse, badRequest, notFound, tooManyRequests } from "../lib/errors";
import { logError, getClientHash } from "../lib/logger";

interface Env {
  DB?: D1Database;
  FRONTEND_BASE_URL?: string;
  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
  SUPPORT_EMAIL?: string;
}

const MAGIC_LINK_TTL_MINUTES = 15;
const EMAIL_RATE_LIMIT_SECONDS = 60; // 1 per email per minute
const IP_RATE_LIMIT_WINDOW = 3600; // 1 hour
const IP_MAX_REQUESTS = 10;

function getAppUrl(env: Env): string {
  return (env.FRONTEND_BASE_URL || "https://healthmatchai.com").replace(/\/$/, "");
}

export async function hashValue(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getClientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown";
}

export async function handleRequestLink(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    throw new AppError(405, "method_not_allowed", "Use POST for this endpoint.");
  }

  let body: { email?: string };
  try {
    body = (await request.json()) as { email?: string };
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }

  const email = (body.email || "").trim().toLowerCase();
  if (!email || !email.includes("@") || email.length > 254) {
    // Return same message as success to avoid email enumeration
    return jsonResponse({
      ok: true,
      message: "If an account exists for this email, a sign-in link has been sent.",
    });
  }

  if (!env.DB) {
    throw new AppError(500, "db_unavailable", "Database is not configured.");
  }

  // Rate limit: same email
  const emailHash = await hashValue(`email:${email}`);
  const emailWindow = Math.floor(Date.now() / 1000 / EMAIL_RATE_LIMIT_SECONDS) * EMAIL_RATE_LIMIT_SECONDS;
  const emailKey = `rl_magic_email:${emailHash}:${emailWindow}`;

  const emailCount = await env.DB.prepare(
    "SELECT request_count FROM api_rate_limits WHERE key = ?"
  ).bind(emailKey).first<{ request_count: number }>();

  if (emailCount && emailCount.request_count >= 1) {
    // Still return success message to avoid enumeration
    return jsonResponse({
      ok: true,
      message: "If an account exists for this email, a sign-in link has been sent.",
    });
  }

  // Rate limit: same IP
  const clientIp = getClientIp(request);
  const ipHash = await hashValue(`ip:${clientIp}`);
  const ipWindow = Math.floor(Date.now() / 1000 / IP_RATE_LIMIT_WINDOW) * IP_RATE_LIMIT_WINDOW;
  const ipKey = `rl_magic_ip:${ipHash}:${ipWindow}`;

  const ipCount = await env.DB.prepare(
    "SELECT request_count FROM api_rate_limits WHERE key = ?"
  ).bind(ipKey).first<{ request_count: number }>();

  if (ipCount && ipCount.request_count >= IP_MAX_REQUESTS) {
    throw tooManyRequests("Too many requests. Please try again later.");
  }

  // Increment rate limit counters
  const upsertRateLimit = async (key: string, clientHash: string, windowStart: number) => {
    const existing = await env.DB!.prepare(
      "SELECT request_count FROM api_rate_limits WHERE key = ?"
    ).bind(key).first<{ request_count: number }>();

    if (existing) {
      await env.DB!.prepare(
        "UPDATE api_rate_limits SET request_count = request_count + 1, updated_at = CURRENT_TIMESTAMP WHERE key = ?"
      ).bind(key).run();
    } else {
      await env.DB!.prepare(
        "INSERT INTO api_rate_limits (key, client_hash, route, window_start, request_count) VALUES (?, ?, 'magic_link', ?, 1)"
      ).bind(key, clientHash, windowStart).run();
    }
  };

  await Promise.all([
    upsertRateLimit(emailKey, emailHash, emailWindow),
    upsertRateLimit(ipKey, ipHash, ipWindow),
  ]);

  // Check if email exists in users table (for user-friendliness, but don't reveal)
  const existingUser = await env.DB.prepare(
    "SELECT id FROM users WHERE email = ?"
  ).bind(email).first<{ id: number }>();

  // Generate token and store hash only
  const token = crypto.randomUUID();
  const tokenHash = await hashValue(token);
  const tokenId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MINUTES * 60 * 1000).toISOString();

  await env.DB.prepare(
    "INSERT INTO auth_tokens (id, email, token_hash, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(tokenId, email, tokenHash, "magic_link", expiresAt, new Date().toISOString()).run();

  const appUrl = getAppUrl(env);
  try {
    await sendMagicLink({ email, token, appUrl }, env);
  } catch (error) {
    console.error("Magic link send failed:", error instanceof Error ? error.message : String(error));
    if (env.DB) {
      await logError(env.DB, {
        eventType: "magic_link_send_failed",
        route: "/api/auth/request-link",
        method: "POST",
        status: 503,
        clientHash: await getClientHash(request),
        message: error instanceof Error ? error.message : "Email send failed",
      });
    }
    // Don't block login — return a graceful message suggesting email+password
    return jsonResponse({
      ok: true,
      message: "Sign-in link is not available right now. Please use email and password to log in or create an account.",
    });
  }

  return jsonResponse({
    ok: true,
    message: "If an account exists for this email, a sign-in link has been sent.",
  });
}

export async function handleVerify(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    throw new AppError(405, "method_not_allowed", "Use GET for this endpoint.");
  }

  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    throw badRequest("Missing token parameter.");
  }

  if (!env.DB) {
    throw new AppError(500, "db_unavailable", "Database is not configured.");
  }

  const tokenHash = await hashValue(token);

  const row = await env.DB.prepare(
    `SELECT id, email, expires_at, consumed_at
     FROM auth_tokens
     WHERE token_hash = ? AND purpose = 'magic_link'
     ORDER BY created_at DESC LIMIT 1`
  ).bind(tokenHash).first<{ id: string; email: string; expires_at: string; consumed_at: string | null }>();

  if (!row) {
    throw notFound("Invalid or expired sign-in link.");
  }
  if (row.consumed_at) {
    throw badRequest("This sign-in link has already been used. Please request a new one.");
  }
  if (new Date(row.expires_at) < new Date()) {
    throw badRequest("This sign-in link has expired. Please request a new one.");
  }

  // Mark token consumed — one-time use only
  await env.DB.prepare("UPDATE auth_tokens SET consumed_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), row.id).run();

  // Find or create user
  let user = await env.DB.prepare("SELECT id, email, display_name as name FROM users WHERE email = ?")
    .bind(row.email).first<{ id: number; email: string; name: string }>();

  if (!user) {
    await env.DB.prepare(
      "INSERT INTO users (email, display_name, preferred_language) VALUES (?, ?, 'English')"
    ).bind(row.email, row.email).run();
    user = await env.DB.prepare("SELECT id, email, display_name as name FROM users WHERE email = ?")
      .bind(row.email).first<{ id: number; email: string; name: string }>();
  }

  if (!user) {
    throw new AppError(500, "user_creation_failed", "Could not create or find user.");
  }

  const { cookie } = await createSession(env.DB, String(user.id));

  const appUrl = getAppUrl(env);
  return new Response(null, {
    status: 302,
    headers: {
      Location: appUrl + "/",
      "Set-Cookie": cookie,
    },
  });
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  if (!env.DB) {
    throw new AppError(500, "db_unavailable", "Database is not configured.");
  }

  const cookieHeader = request.headers.get("Cookie");
  const clearCookie = await destroySession(env.DB, cookieHeader);

  return jsonResponse({ ok: true }, 200, { "Set-Cookie": clearCookie });
}

export async function handleMe(request: Request, env: Env): Promise<Response> {
  if (!env.DB) {
    throw new AppError(500, "db_unavailable", "Database is not configured.");
  }

  const cookieHeader = request.headers.get("Cookie");
  const session = await verifyAndGetSession(env.DB, cookieHeader);

  if (!session) {
    return jsonResponse({ user: null, entitlement: null });
  }

  const entitlement = await env.DB.prepare(
    `SELECT plan, status, current_period_end
     FROM entitlements
     WHERE user_id = ? AND status = 'active'
     ORDER BY CASE plan WHEN 'plus' THEN 1 WHEN 'one_time_report' THEN 2 ELSE 3 END
     LIMIT 1`
  ).bind(session.user.id).first<{ plan: string; status: string; current_period_end: string | null }>();

  return jsonResponse({
    user: session.user,
    entitlement: entitlement
      ? { plan: entitlement.plan, status: entitlement.status, currentPeriodEnd: entitlement.current_period_end || undefined }
      : null,
  });
}

// ---- Email + Password Auth ----

async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.randomUUID();
  const data = encoder.encode(password + salt);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${salt}:${hash}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) return false;
  const encoder = new TextEncoder();
  const data = encoder.encode(password + salt);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const computed = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return computed === hash;
}

export async function handleRegister(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    throw new AppError(405, "method_not_allowed", "Use POST for this endpoint.");
  }

  let body: { email?: string; password?: string; name?: string };
  try {
    body = (await request.json()) as { email?: string; password?: string; name?: string };
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }

  const email = (body.email || "").trim().toLowerCase();
  const password = (body.password || "").trim();
  const displayName = (body.name || email).trim();

  if (!email || !email.includes("@") || email.length > 254) {
    throw badRequest("Please enter a valid email address.");
  }
  if (!password || password.length < 8) {
    return jsonResponse({
      ok: false,
      code: "INVALID_PASSWORD",
      message: "Password must be at least 8 characters.",
    }, 400);
  }

  if (!env.DB) {
    throw new AppError(500, "db_unavailable", "Database is not configured.");
  }

  // Check if user already exists
  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?")
    .bind(email).first<{ id: number }>();

  if (existing) {
    return jsonResponse({
      ok: false,
      code: "EMAIL_ALREADY_EXISTS",
      message: "Email already exists.",
    }, 409);
  }

  const passwordHash = await hashPassword(password);

  try {
    await env.DB.prepare(
      "INSERT INTO users (email, display_name, preferred_language, password_hash) VALUES (?, ?, 'English', ?)"
    ).bind(email, displayName, passwordHash).run();
  } catch (error) {
    return jsonResponse({
      ok: false,
      code: "D1_INSERT_FAILED",
      message: error instanceof Error ? error.message : "Database insert failed.",
    }, 500);
  }

  // Retrieve the auto-generated id
  const user = await env.DB.prepare(
    "SELECT id, email, display_name as name FROM users WHERE email = ?"
  ).bind(email).first<{ id: number; email: string; name: string }>();

  if (!user) {
    return jsonResponse({
      ok: false,
      code: "D1_INSERT_FAILED",
      message: "Account created but could not retrieve user record.",
    }, 500);
  }

  const { cookie } = await createSession(env.DB, String(user.id));

  return jsonResponse({
    ok: true,
    user: { id: user.id, email: user.email, name: user.name },
    message: "Account created successfully.",
  }, 201, { "Set-Cookie": cookie });
}

export async function handleLogin(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    throw new AppError(405, "method_not_allowed", "Use POST for this endpoint.");
  }

  let body: { email?: string; password?: string };
  try {
    body = (await request.json()) as { email?: string; password?: string };
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }

  const email = (body.email || "").trim().toLowerCase();
  const password = (body.password || "").trim();

  if (!email || !password) {
    throw badRequest("Email and password are required.");
  }

  if (!env.DB) {
    throw new AppError(500, "db_unavailable", "Database is not configured.");
  }

  const user = await env.DB.prepare(
    "SELECT id, email, display_name, password_hash FROM users WHERE email = ?"
  ).bind(email).first<{ id: number; email: string; display_name: string; password_hash: string | null }>();

  if (!user || !user.password_hash) {
    throw new AppError(401, "invalid_credentials", "Invalid email or password. If you haven't created an account yet, please sign up.");
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    throw new AppError(401, "invalid_credentials", "Invalid email or password.");
  }

  const { cookie } = await createSession(env.DB, String(user.id));

  return jsonResponse({
    ok: true,
    user: { id: user.id, email: user.email, name: user.display_name },
    message: "Logged in successfully.",
  }, 200, { "Set-Cookie": cookie });
}
