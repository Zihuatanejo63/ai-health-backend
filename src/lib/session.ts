/**
 * Server-side session management.
 * Sessions are stored in D1 with only the hash of the session token.
 * The plaintext session token is set as an HttpOnly cookie.
 */

import type { D1Database } from "@cloudflare/workers-types";

const SESSION_COOKIE = "hm_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days
const SESSION_CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour (not strictly enforced, just documented)

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface SessionResult {
  user: SessionUser;
  sessionId: string;
}

function generateToken(): string {
  return crypto.randomUUID();
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function sessionCookie(token: string, maxAge = SESSION_MAX_AGE_SECONDS): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export async function createSession(
  db: D1Database,
  userId: string
): Promise<{ token: string; cookie: string }> {
  const token = generateToken();
  const sessionHash = await hashToken(token);
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();

  await db
    .prepare(
      "INSERT INTO sessions (id, user_id, session_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(sessionId, userId, sessionHash, expiresAt, new Date().toISOString())
    .run();

  return { token, cookie: sessionCookie(token) };
}

export async function verifyAndGetSession(
  db: D1Database,
  cookieHeader: string | null
): Promise<SessionResult | null> {
  if (!cookieHeader) return null;

  const token = extractCookie(cookieHeader, SESSION_COOKIE);
  if (!token) return null;

  const sessionHash = await hashToken(token);

  const row = await db
    .prepare(
      `SELECT s.id, s.user_id, s.expires_at, u.email, u.name, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.session_hash = ? AND s.expires_at > ?`
    )
    .bind(sessionHash, new Date().toISOString())
    .first<{
      id: string;
      user_id: string;
      expires_at: string;
      email: string;
      name: string;
      role: string;
    }>();

  if (!row) return null;

  return {
    user: {
      id: row.user_id,
      email: row.email || "",
      name: row.name || row.email || "",
      role: row.role || "user",
    },
    sessionId: row.id,
  };
}

export async function destroySession(
  db: D1Database,
  cookieHeader: string | null
): Promise<string> {
  if (!cookieHeader) return clearSessionCookie();

  const token = extractCookie(cookieHeader, SESSION_COOKIE);
  if (token) {
    const sessionHash = await hashToken(token);
    await db.prepare("DELETE FROM sessions WHERE session_hash = ?").bind(sessionHash).run();
  }

  // Also clean up expired sessions
  await db
    .prepare("DELETE FROM sessions WHERE expires_at < ?")
    .bind(new Date().toISOString())
    .run();

  return clearSessionCookie();
}

function extractCookie(cookieHeader: string, name: string): string | null {
  const match = cookieHeader.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Require authentication. Returns session or throws.
 */
export async function requireSession(
  db: D1Database,
  cookieHeader: string | null
): Promise<SessionResult> {
  const session = await verifyAndGetSession(db, cookieHeader);
  if (!session) {
    throw Object.assign(new Error("Authentication required"), { status: 401, code: "unauthorized" });
  }
  return session;
}

/**
 * Optionally get session, returns null if not logged in.
 */
export async function optionalSession(
  db: D1Database,
  cookieHeader: string | null
): Promise<SessionResult | null> {
  return verifyAndGetSession(db, cookieHeader);
}
