/**
 * Server-side session management.
 * Sessions are stored in D1 with the plaintext session token.
 * The session token is set as an HttpOnly cookie.
 */

import type { D1Database } from "@cloudflare/workers-types";

const SESSION_COOKIE = "hm_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

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

export function sessionCookie(token: string, maxAge = SESSION_MAX_AGE_SECONDS): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export async function createSession(
  db: D1Database,
  userId: number
): Promise<{ token: string; cookie: string }> {
  const token = generateToken();
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();

  await db
    .prepare(
      "INSERT INTO sessions (id, user_id, token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(sessionId, userId, token, expiresAt, new Date().toISOString())
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

  const row = await db
    .prepare(
      `SELECT s.id, s.user_id, s.expires_at, u.email, u.display_name as name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .bind(token, new Date().toISOString())
    .first<{
      id: string;
      user_id: number;
      expires_at: string;
      email: string;
      name: string;
    }>();

  if (!row) return null;

  return {
    user: {
      id: String(row.user_id),
      email: row.email || "",
      name: row.name || row.email || "",
      role: "user",
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
    await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
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
