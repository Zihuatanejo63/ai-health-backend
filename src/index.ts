/**
 * HealthMatchAI Backend — Cloudflare Worker entry point.
 * Routes requests to modular handlers.
 *
 * Security fixes applied:
 * - Gemini API key sent via x-goog-api-key header (never in URL)
 * - Auth via HttpOnly session cookie
 * - Entitlements verified server-side
 * - Health data encrypted at rest
 * - Creem webhooks verified and idempotent
 */

import { errorResponse } from "./lib/errors";
import { handleRequestLink, handleVerify, handleLogout, handleMe, handleRegister, handleLogin, handleUpdateProfile } from "./routes/auth";
import { handleTriage } from "./routes/triage";
import {
  handleGetSymptomChecks,
  handleGetSymptomCheck,
  handleDeleteSymptomCheck,
  handleGetHealthProfile,
  handlePutHealthProfile,
  handleGetInsuranceProfile,
  handlePutInsuranceProfile,
  handleExportData,
  handleDeleteData,
} from "./routes/data";
import { handleCreateCheckout, handleCreemWebhook } from "./routes/payments";
import { handleAdminDashboard, handleAdminUserLookup, handleAdminEntitlements, handleAdminLedger, handleAdminMarkPayout } from "./routes/admin";

interface Env {
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  GEMINI_BASE_URL?: string;
  FRONTEND_BASE_URL?: string;
  PAYMENT_CHECKOUT_URL?: string;
  PAYMENT_PROVIDER?: string;
  ADMIN_API_TOKEN?: string;
  DATA_ENCRYPTION_KEY?: string;
  CREEM_API_KEY?: string;
  CREEM_WEBHOOK_SECRET?: string;
  CREEM_PLUS_MONTHLY_PRODUCT_ID?: string;
  CREEM_API_BASE_URL?: string;
  DB?: D1Database;
}

// CORS config
function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  const allowedOrigins = new Set([
    env.FRONTEND_BASE_URL || "https://healthmatchai.com",
    "https://healthmatchai.com",
    "https://www.healthmatchai.com",
    "https://ai-health-frontend.pages.dev",
    "http://localhost:3000",
  ]);

  return {
    "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "https://healthmatchai.com",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

// Route table: [method, pathPattern, handler]
type Handler = (request: Request, env: Env, ...rest: string[]) => Promise<Response>;

interface Route {
  method: string | string[];
  pattern: string | URLPattern;
  handler: Handler;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    const url = new URL(request.url);

    // Log env check on first cold start per path
    if (url.pathname === "/api/create-checkout-session") {
      console.log("[env check]", {
        paymentProvider: env.PAYMENT_PROVIDER || "unset",
        creemBaseUrl: env.CREEM_API_BASE_URL || "unset",
        hasCreemApiKey: !!env.CREEM_API_KEY,
        hasPlusProductId: !!env.CREEM_PLUS_MONTHLY_PRODUCT_ID,
      });
    }

    try {
      // Auth routes
      if (url.pathname === "/api/auth/request-link") {
        return withCors(await handleRequestLink(request, env), request, env);
      }
      if (url.pathname === "/api/auth/verify") {
        return withCors(await handleVerify(request, env), request, env);
      }
      if (url.pathname === "/api/auth/logout") {
        return withCors(await handleLogout(request, env), request, env);
      }
      if (url.pathname === "/api/auth/register") {
        return withCors(await handleRegister(request, env), request, env);
      }
      if (url.pathname === "/api/auth/login") {
        return withCors(await handleLogin(request, env), request, env);
      }
      if (url.pathname === "/api/me") {
        if (request.method === "PATCH") {
          return withCors(await handleUpdateProfile(request, env), request, env);
        }
        return withCors(await handleMe(request, env), request, env);
      }

      // Triage
      if (url.pathname === "/api/triage") {
        return withCors(await handleTriage(request, env), request, env);
      }

      // Data routes
      if (url.pathname === "/api/symptom-checks") {
        return withCors(await handleGetSymptomChecks(request, env), request, env);
      }
      if (url.pathname.startsWith("/api/symptom-checks/")) {
        const checkId = url.pathname.split("/api/symptom-checks/")[1];
        if (request.method === "GET") {
          return withCors(await handleGetSymptomCheck(request, env, checkId), request, env);
        }
        if (request.method === "DELETE") {
          return withCors(await handleDeleteSymptomCheck(request, env, checkId), request, env);
        }
      }
      if (url.pathname === "/api/health-profile") {
        if (request.method === "GET") {
          return withCors(await handleGetHealthProfile(request, env), request, env);
        }
        if (request.method === "PUT") {
          return withCors(await handlePutHealthProfile(request, env), request, env);
        }
      }
      if (url.pathname === "/api/insurance-profile") {
        if (request.method === "GET") {
          return withCors(await handleGetInsuranceProfile(request, env), request, env);
        }
        if (request.method === "PUT") {
          return withCors(await handlePutInsuranceProfile(request, env), request, env);
        }
      }
      if (url.pathname === "/api/data/export") {
        return withCors(await handleExportData(request, env), request, env);
      }
      if (url.pathname === "/api/data/delete") {
        return withCors(await handleDeleteData(request, env), request, env);
      }

      // Payment routes
      if (url.pathname === "/api/create-checkout-session") {
        return withCors(await handleCreateCheckout(request, env), request, env);
      }
      if (url.pathname === "/api/webhooks/creem") {
        // Webhook responses don't need CORS headers
        return handleCreemWebhook(request, env);
      }

      // Admin routes
      if (url.pathname === "/api/admin/dashboard") {
        return withCors(await handleAdminDashboard(request, env), request, env);
      }
      if (url.pathname === "/api/admin/users") {
        return withCors(await handleAdminUserLookup(request, env), request, env);
      }
      if (url.pathname === "/api/admin/entitlements") {
        return withCors(await handleAdminEntitlements(request, env), request, env);
      }
      if (url.pathname === "/api/admin/ledger") {
        return withCors(await handleAdminLedger(request, env), request, env);
      }
      if (url.pathname === "/api/admin/mark-payout") {
        return withCors(await handleAdminMarkPayout(request, env), request, env);
      }

      // Legacy compat: /api/analyze-symptoms -> /api/triage
      if (url.pathname === "/api/analyze-symptoms") {
        return withCors(await handleTriage(request, env), request, env);
      }

      // 404
      return withCors(
        new Response(
          JSON.stringify({ error: { code: "not_found", message: "Route not found." } }),
          { status: 404, headers: { "Content-Type": "application/json; charset=utf-8" } }
        ),
        request,
        env
      );
    } catch (error) {
      return withCors(errorResponse(error), request, env);
    }
  },
};

function withCors(response: Response, request: Request, env: Env): Response {
  const headers = corsHeaders(request, env);
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
  return response;
}
