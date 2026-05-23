/**
 * API integration tests for route handlers.
 * Tests handler functions with mocked Request/Env objects.
 * Run: npx tsx scripts/test-integration.ts
 */

import { evalTriage } from "../src/lib/triage-engine";
import { containsForbiddenContent } from "../src/lib/gemini";
import { hashValue } from "../src/routes/auth";
import { verifyCreemSignature } from "../src/routes/payments";
import type { TriageApiRequest } from "../src/types";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) { passed++; console.log(`  ✓ ${message}`); }
  else { failed++; console.error(`  ✗ ${message}`); }
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  assert(actual === expected, `${message} (got: ${JSON.stringify(actual)})`);
}

// ---- Helper: create mock Request ----

function mockRequest(method: string, path: string, opts?: {
  body?: unknown;
  headers?: Record<string, string>;
  cookie?: string;
}): Request {
  const url = new URL(path, "https://test.workers.dev");
  const init: RequestInit = { method };
  const headers = new Headers(opts?.headers || {});
  if (opts?.cookie) headers.set("Cookie", opts.cookie);
  if (opts?.body) {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(opts.body);
  }
  init.headers = headers;
  return new Request(url.toString(), init);
}

// ---- Helper: mock Env ----

function mockEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    DB: undefined, // no DB by default
    FRONTEND_BASE_URL: "https://healthmatchai.com",
    ...overrides,
  };
}

async function main() {
  // ============================================================
  // 1. POST /api/auth/request-link — input validation
  // ============================================================
  console.log("\n--- POST /api/auth/request-link ---");

  // 1a. Invalid JSON body
  {
    const req = new Request("https://test.workers.dev/api/auth/request-link", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not json",
    });
    // Import handler dynamically to avoid top-level issues
    const { handleRequestLink } = await import("../src/routes/auth");
    try {
      await handleRequestLink(req, mockEnv() as Parameters<typeof handleRequestLink>[1]);
      assert(false, "Invalid JSON: should throw");
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      assertEq(e.status, 400, "Invalid JSON: returns 400");
    }
  }

  // 1b. Missing email
  {
    const { handleRequestLink } = await import("../src/routes/auth");
    const req = mockRequest("POST", "/api/auth/request-link", { body: {} });
    const res = await handleRequestLink(req, mockEnv() as Parameters<typeof handleRequestLink>[1]);
    const data = await res.json() as Record<string, unknown>;
    assertEq(res.status, 200, "Missing email: returns 200 (anti-enumeration)");
    assert(typeof data.message === "string", "Missing email: has message");
  }

  // 1c. Invalid email format
  {
    const { handleRequestLink } = await import("../src/routes/auth");
    const req = mockRequest("POST", "/api/auth/request-link", { body: { email: "notanemail" } });
    const res = await handleRequestLink(req, mockEnv() as Parameters<typeof handleRequestLink>[1]);
    assertEq(res.status, 200, "Invalid email: returns 200 (anti-enumeration)");
  }

  // 1d. Valid email but no DB configured
  {
    const { handleRequestLink } = await import("../src/routes/auth");
    const req = mockRequest("POST", "/api/auth/request-link", { body: { email: "test@example.com" } });
    try {
      await handleRequestLink(req, mockEnv() as Parameters<typeof handleRequestLink>[1]);
      assert(false, "No DB: should throw");
    } catch (err: unknown) {
      const e = err as { status?: number };
      assertEq(e.status, 500, "No DB: returns 500");
    }
  }

  // 1e. Wrong method
  {
    const { handleRequestLink } = await import("../src/routes/auth");
    const req = mockRequest("GET", "/api/auth/request-link");
    try {
      await handleRequestLink(req, mockEnv() as Parameters<typeof handleRequestLink>[1]);
      assert(false, "GET: should throw");
    } catch (err: unknown) {
      const e = err as { status?: number };
      assertEq(e.status, 405, "GET: returns 405");
    }
  }

  // ============================================================
  // 2. GET /api/auth/verify — token validation
  // ============================================================
  console.log("\n--- GET /api/auth/verify ---");

  // 2a. Missing token parameter
  {
    const { handleVerify } = await import("../src/routes/auth");
    const req = mockRequest("GET", "/api/auth/verify");
    try {
      await handleVerify(req, mockEnv() as Parameters<typeof handleVerify>[1]);
      assert(false, "Missing token: should throw");
    } catch (err: unknown) {
      const e = err as { status?: number };
      assertEq(e.status, 400, "Missing token: returns 400");
    }
  }

  // 2b. No DB
  {
    const { handleVerify } = await import("../src/routes/auth");
    const req = mockRequest("GET", "/api/auth/verify?token=some-token");
    try {
      await handleVerify(req, mockEnv() as Parameters<typeof handleVerify>[1]);
      assert(false, "No DB: should throw");
    } catch (err: unknown) {
      const e = err as { status?: number };
      assertEq(e.status, 500, "No DB: returns 500");
    }
  }

  // ============================================================
  // 3. GET /api/me — null user without cookie (no DB = error)
  // ============================================================
  console.log("\n--- GET /api/me ---");

  {
    const { handleMe } = await import("../src/routes/auth");
    const req = mockRequest("GET", "/api/me");
    try {
      await handleMe(req, mockEnv() as Parameters<typeof handleMe>[1]);
      assert(false, "No DB: should throw");
    } catch (err: unknown) {
      const e = err as { status?: number };
      assertEq(e.status, 500, "No DB: /api/me returns 500");
    }
  }

  // ============================================================
  // 4. POST /api/auth/logout — clears cookie
  // ============================================================
  console.log("\n--- POST /api/auth/logout ---");

  {
    const { handleLogout } = await import("../src/routes/auth");
    const req = mockRequest("POST", "/api/auth/logout");
    try {
      await handleLogout(req, mockEnv() as Parameters<typeof handleLogout>[1]);
      assert(false, "No DB: should throw");
    } catch (err: unknown) {
      const e = err as { status?: number };
      assertEq(e.status, 500, "No DB: logout returns 500");
    }
  }

  // ============================================================
  // 5. POST /api/create-checkout-session — requires auth
  // ============================================================
  console.log("\n--- POST /api/create-checkout-session ---");

  // 5a. No session cookie — requires DB mock for full test
  // Note: requireDb() fires before requireSession(), so without DB mock returns 500
  {
    const { handleCreateCheckout } = await import("../src/routes/payments");
    const req = mockRequest("POST", "/api/create-checkout-session", {
      body: { plan: "one_time_report" },
    });
    try {
      await handleCreateCheckout(req, mockEnv({ DB: undefined }) as Parameters<typeof handleCreateCheckout>[1]);
      assert(false, "No DB: should throw");
    } catch (err: unknown) {
      const e = err as { status?: number };
      assertEq(e.status, 500, "Checkout no DB: returns 500 (requireDb before auth)");
    }
  }

  // 5b. Invalid plan (before auth, but DB check comes first)
  {
    const { handleCreateCheckout } = await import("../src/routes/payments");
    const req = mockRequest("POST", "/api/create-checkout-session", {
      body: { plan: "invalid_plan" },
    });
    try {
      await handleCreateCheckout(req, mockEnv({ DB: undefined }) as Parameters<typeof handleCreateCheckout>[1]);
      assert(false, "No DB: should throw");
    } catch (err: unknown) {
      const e = err as { status?: number };
      assertEq(e.status, 500, "Invalid plan no DB: returns 500 (requireDb before validation)");
    }
  }

  // ============================================================
  // 6. POST /api/webhooks/creem — signature verification
  // ============================================================
  console.log("\n--- POST /api/webhooks/creem ---");

  // 6a. Missing CREEM_WEBHOOK_SECRET
  {
    const { handleCreemWebhook } = await import("../src/routes/payments");
    const req = mockRequest("POST", "/api/webhooks/creem", {
      body: {},
      headers: { "creem-signature": "test" },
    });
    try {
      await handleCreemWebhook(req, mockEnv({
        DB: undefined,
        CREEM_WEBHOOK_SECRET: undefined,
      }) as Parameters<typeof handleCreemWebhook>[1]);
      assert(false, "No secret: should throw");
    } catch (err: unknown) {
      const e = err as { status?: number };
      assertEq(e.status, 500, "No secret: returns 500");
    }
  }

  // 6b. Missing signature header (DB check comes first)
  {
    const { handleCreemWebhook } = await import("../src/routes/payments");
    const req = mockRequest("POST", "/api/webhooks/creem", { body: {} });
    try {
      await handleCreemWebhook(req, mockEnv({
        DB: undefined,
        CREEM_WEBHOOK_SECRET: "test-secret",
      }) as Parameters<typeof handleCreemWebhook>[1]);
      assert(false, "No DB: should throw");
    } catch (err: unknown) {
      const e = err as { status?: number };
      assertEq(e.status, 500, "No sig no DB: returns 500 (requireDb before sig check)");
    }
  }

  // 6c. Invalid signature (DB check comes first)
  {
    const { handleCreemWebhook } = await import("../src/routes/payments");
    const req = mockRequest("POST", "/api/webhooks/creem", {
      body: { eventType: "checkout.completed" },
      headers: { "creem-signature": "invalid" },
    });
    try {
      await handleCreemWebhook(req, mockEnv({
        DB: undefined,
        CREEM_WEBHOOK_SECRET: "test-secret",
      }) as Parameters<typeof handleCreemWebhook>[1]);
      assert(false, "No DB: should throw");
    } catch (err: unknown) {
      const e = err as { status?: number };
      assertEq(e.status, 500, "Invalid sig no DB: returns 500 (requireDb before sig check)");
    }
  }

  // 6d. Valid signature but no DB
  {
    const secret = "test-secret";
    const body = JSON.stringify({ eventType: "checkout.completed", id: "evt_001" });
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const sig = Array.from(new Uint8Array(sigBuf)).map((b) => b.toString(16).padStart(2, "0")).join("");

    const { handleCreemWebhook } = await import("../src/routes/payments");
    const req = new Request("https://test.workers.dev/api/webhooks/creem", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "creem-signature": sig,
      },
      body,
    });
    try {
      await handleCreemWebhook(req, mockEnv({
        DB: undefined,
        CREEM_WEBHOOK_SECRET: secret,
      }) as Parameters<typeof handleCreemWebhook>[1]);
      assert(false, "Valid sig but no DB: should throw");
    } catch (err: unknown) {
      const e = err as { status?: number };
      assertEq(e.status, 500, "Valid sig but no DB: returns 500");
    }
  }

  // ============================================================
  // 7. POST /api/triage — basic request
  // ============================================================
  console.log("\n--- POST /api/triage ---");

  // 7a. Valid basic triage request (no DB)
  {
    const { handleTriage } = await import("../src/routes/triage");
    const req = mockRequest("POST", "/api/triage", {
      body: {
        symptoms: ["headache"],
        primarySymptom: "headache",
        duration: "lessThan24h",
        trend: "stable",
        severity: "moderate",
        painScore: 3,
        redFlags: [],
        functionImpact: [],
        healthBackground: {},
      },
    });
    try {
      const res = await handleTriage(req, mockEnv({
        GEMINI_API_KEY: undefined,
      }) as Parameters<typeof handleTriage>[1]);
      assertEq(res.status, 200, "Valid triage: returns 200");
      const data = await res.json() as Record<string, unknown>;
      assert(typeof data.riskLevel === "string", "Valid triage: has riskLevel");
      assert(typeof data.recommendedCare === "string", "Valid triage: has recommendedCare");
      assert(typeof data.disclaimer === "string", "Valid triage: has disclaimer");
      assert(data.aiReviewStatus === "unavailable", "Valid triage: aiReviewStatus is unavailable without API key");
    } catch (err: unknown) {
      const e = err as { message?: string };
      assert(false, `Valid triage should not throw: ${e.message || "unknown"}`);
    }
  }

  // 7b. Missing symptoms
  {
    const { handleTriage } = await import("../src/routes/triage");
    const req = mockRequest("POST", "/api/triage", {
      body: {
        symptoms: [],
        primarySymptom: "",
        duration: "lessThan24h",
        trend: "stable",
        severity: "mild",
        painScore: 0,
        redFlags: [],
        functionImpact: [],
        healthBackground: {},
      },
    });
    try {
      await handleTriage(req, mockEnv() as Parameters<typeof handleTriage>[1]);
      assert(false, "Empty symptoms: should throw");
    } catch (err: unknown) {
      const e = err as { status?: number };
      assertEq(e.status, 400, "Empty symptoms: returns 400");
    }
  }

  // 7c. Crisis triage (Gemini not called, fallback used)
  {
    const { handleTriage } = await import("../src/routes/triage");
    const req = mockRequest("POST", "/api/triage", {
      body: {
        symptoms: ["suicidal-thoughts"],
        primarySymptom: "suicidal-thoughts",
        duration: "lessThan24h",
        trend: "stable",
        severity: "severe",
        painScore: 0,
        redFlags: [],
        functionImpact: [],
        healthBackground: {},
      },
    });
    const res = await handleTriage(req, mockEnv({
      GEMINI_API_KEY: undefined,
    }) as Parameters<typeof handleTriage>[1]);
    const data = await res.json() as Record<string, unknown>;
    assertEq(data.riskLevel, "Crisis", "Crisis: riskLevel is Crisis");
    assert(data.aiReviewStatus === "unavailable", "Crisis: aiReviewStatus is unavailable");
    assert(typeof data.escalationAdvice === "object", "Crisis: has escalationAdvice");
  }

  // ============================================================
  // 8. Data routes — require auth
  // ============================================================
  console.log("\n--- Data Routes (auth gate) ---");

  {
    const { handleGetSymptomChecks } = await import("../src/routes/data");
    const req = mockRequest("GET", "/api/symptom-checks");
    try {
      await handleGetSymptomChecks(req, mockEnv() as Parameters<typeof handleGetSymptomChecks>[1]);
      assert(false, "No DB: should throw");
    } catch (err: unknown) {
      const e = err as { status?: number };
      assertEq(e.status, 500, "Symptom checks: no DB returns 500");
    }
  }

  {
    const { handleExportData } = await import("../src/routes/data");
    const req = mockRequest("GET", "/api/data/export");
    try {
      await handleExportData(req, mockEnv() as Parameters<typeof handleExportData>[1]);
      assert(false, "No DB: should throw");
    } catch (err: unknown) {
      const e = err as { status?: number };
      assertEq(e.status, 500, "Data export: no DB returns 500");
    }
  }

  // ============================================================
  // 9. Triage engine — Gemini fallback
  // ============================================================
  console.log("\n--- Triage: Gemini Fallback ---");

  // Emergency disables AI
  {
    const result = evalTriage({
      symptoms: ["chest-pain", "shortness-of-breath"],
      primarySymptom: "chest-pain",
      duration: "lessThan24h",
      trend: "stable",
      severity: "severe",
      painScore: 5,
      redFlags: ["chestPainOrPressure", "troubleBreathing"],
      functionImpact: [],
      healthBackground: {},
    });
    assert(result.isEmergency, "Emergency: isEmergency is true (AI disabled)");
    assertEq(result.riskLevel, "Emergency", "Emergency: riskLevel correct");
  }

  // Non-emergency can use AI
  {
    const result = evalTriage({
      symptoms: ["cough"],
      primarySymptom: "cough",
      duration: "oneToThreeDays",
      trend: "gettingBetter",
      severity: "mild",
      painScore: 1,
      redFlags: [],
      functionImpact: [],
      healthBackground: {},
    });
    assert(!result.isEmergency, "Mild cough: isEmergency is false (AI allowed)");
    assertEq(result.riskLevel, "Low", "Mild cough: riskLevel Low");
  }

  // ============================================================
  // 10. Admin — requires token
  // ============================================================
  console.log("\n--- Admin Routes (auth gate) ---");

  {
    const { handleAdminDashboard } = await import("../src/routes/admin");
    const req = mockRequest("GET", "/api/admin/dashboard");
    try {
      await handleAdminDashboard(req, mockEnv({
        ADMIN_API_TOKEN: undefined,
      }) as Parameters<typeof handleAdminDashboard>[1]);
      assert(false, "No token: should throw");
    } catch (err: unknown) {
      const e = err as { status?: number };
      assertEq(e.status, 401, "Admin: no token returns 401");
    }
  }

  {
    const { handleAdminUserLookup } = await import("../src/routes/admin");
    const req = mockRequest("GET", "/api/admin/users?email=test@example.com");
    try {
      await handleAdminUserLookup(req, mockEnv({
        ADMIN_API_TOKEN: undefined,
      }) as Parameters<typeof handleAdminUserLookup>[1]);
      assert(false, "No token: should throw");
    } catch (err: unknown) {
      const e = err as { status?: number };
      assertEq(e.status, 401, "Admin user lookup: no token returns 401");
    }
  }

  // ============================================================
  // Summary
  // ============================================================
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Integration: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  console.log(`${"=".repeat(50)}`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
