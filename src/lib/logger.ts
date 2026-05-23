/**
 * Structured error logging.
 * Logs event type, route, status, and sanitized message only.
 * Never logs: symptom data, health profiles, Gemini prompts/responses, API keys, tokens.
 */

import type { D1Database } from "@cloudflare/workers-types";

const LOG_EVENT_TYPES = [
  "magic_link_send_failed",
  "checkout_create_failed",
  "creem_webhook_invalid_signature",
  "creem_webhook_processing_failed",
  "gemini_call_failed",
  "d1_write_failed",
  "unauthorized_access_attempt",
] as const;

export type LogEventType = (typeof LOG_EVENT_TYPES)[number];

export interface LogEntry {
  eventType: LogEventType;
  route?: string;
  method?: string;
  status?: number;
  clientHash: string;
  message: string;
}

async function hashClient(clientIp: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`ip:${clientIp}`));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export async function logError(db: D1Database, entry: LogEntry): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO error_logs (id, event_type, route, method, status, client_hash, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        entry.eventType,
        entry.route || null,
        entry.method || null,
        entry.status || null,
        entry.clientHash,
        entry.message.slice(0, 500),
        new Date().toISOString()
      )
      .run();
  } catch {
    // Logging should never break the request — silently drop if D1 is unavailable
  }
}

export function getClientHash(request: Request): Promise<string> {
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown";
  return hashClient(ip);
}
