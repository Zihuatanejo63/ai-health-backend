type Severity = "mild" | "moderate" | "severe";
type DurationUnit = "hours" | "days" | "weeks" | "months";
type RiskLevel = "low" | "medium" | "high";

type AnalyzeSymptomsRequest = {
  symptoms: string;
  severity: Severity;
  durationValue: number;
  durationUnit: DurationUnit;
  outputLanguage?: string;
  imageBase64?: string;
  imageMimeType?: string;
};

type AnalyzeSymptomsResponse = {
  riskLevel: RiskLevel;
  summary: string;
  recommendedDepartments: string[];
  nextSteps: string[];
  disclaimer: string;
  referenceId: string;
};

type CheckoutRequest = {
  doctorId: string;
  doctorName: string;
  amountUsd: number;
  patientEmail?: string;
  caseReferenceId?: string;
};

type CheckoutResponse = {
  checkoutUrl: string;
  sessionId: string;
  accounting: AccountingSplit;
};

type AccountingSplit = {
  grossAmountUsd: number;
  platformFeeRateBps: number;
  platformFeeUsd: number;
  doctorPayoutUsd: number;
};

type MarkPayoutRequest = {
  orderId: number;
  payoutMethod?: string;
  payoutReference?: string;
};

interface Env {
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  GEMINI_BASE_URL?: string;
  FRONTEND_BASE_URL?: string;
  PAYMENT_CHECKOUT_URL?: string;
  PAYMENT_PROVIDER?: string;
  ADMIN_API_TOKEN?: string;
  DB?: D1Database;
}

const DISCLAIMER =
  "Medical disclaimer: This output is AI-generated triage support, not a diagnosis. " +
  "Always consult a licensed clinician. If symptoms are severe, worsening, or life-threatening, seek emergency care.";

const RATE_LIMIT_WINDOW_SECONDS = 60;
const ANALYZE_RATE_LIMIT = 12;
const CHECKOUT_RATE_LIMIT = 20;
const PLATFORM_FEE_RATE_BPS = 3000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (url.pathname === "/api/analyze-symptoms") {
      return withApiLog(request, env, "analyze_symptoms", () => handleAnalyzeSymptoms(request, env));
    }

    if (url.pathname === "/api/create-checkout-session") {
      return withApiLog(request, env, "create_checkout_session", () =>
        handleCreateCheckoutSession(request, env)
      );
    }

    if (url.pathname === "/api/admin/ledger") {
      return withApiLog(request, env, "admin_ledger", () => handleAdminLedger(request, env));
    }

    if (url.pathname === "/api/admin/mark-payout") {
      return withApiLog(request, env, "admin_mark_payout", () =>
        handleAdminMarkPayout(request, env)
      );
    }

    return json(
      {
        error: {
          code: "not_found",
          message: "Route not found."
        }
      },
      404,
      request,
      env
    );
  }
};

async function handleAnalyzeSymptoms(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return json(
      {
        error: {
          code: "method_not_allowed",
          message: "Use POST for this endpoint."
        }
      },
      405,
      request,
      env
    );
  }

  const rateLimit = await enforceRateLimit(request, env, "analyze_symptoms", ANALYZE_RATE_LIMIT);
  if (!rateLimit.allowed) {
    return json(
      {
        error: {
          code: "rate_limited",
          message: "Too many requests. Please wait a minute and try again."
        }
      },
      429,
      request,
      env
    );
  }

  if (!env.GEMINI_API_KEY) {
    return json(
      {
        error: {
          code: "config_error",
          message: "GEMINI_API_KEY is not configured."
        }
      },
      500,
      request,
      env
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(
      {
        error: {
          code: "invalid_json",
          message: "Request body must be valid JSON."
        }
      },
      400,
      request,
      env
    );
  }

  const validation = validateRequest(body);
  if (!validation.valid) {
    return json(
      {
        error: {
          code: "invalid_input",
          message: validation.message
        }
      },
      400,
      request,
      env
    );
  }

  try {
    const aiResult = await callGemini(validation.data, env);
    await saveCase(validation.data, aiResult, env);
    return json(aiResult, 200, request, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gemini request failed.";
    return json(
      {
        error: {
          code: "gemini_error",
          message
        }
      },
      502,
      request,
      env
    );
  }
}

async function handleCreateCheckoutSession(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return json(
      {
        error: {
          code: "method_not_allowed",
          message: "Use POST for this endpoint."
        }
      },
      405,
      request,
      env
    );
  }

  const rateLimit = await enforceRateLimit(
    request,
    env,
    "create_checkout_session",
    CHECKOUT_RATE_LIMIT
  );
  if (!rateLimit.allowed) {
    return json(
      {
        error: {
          code: "rate_limited",
          message: "Too many checkout attempts. Please wait a minute and try again."
        }
      },
      429,
      request,
      env
    );
  }

  if (!env.PAYMENT_CHECKOUT_URL) {
    return json(
      {
        error: {
          code: "config_error",
          message:
            "PAYMENT_CHECKOUT_URL is not configured. Add a Paddle or Lemon Squeezy hosted checkout link."
        }
      },
      500,
      request,
      env
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(
      {
        error: {
          code: "invalid_json",
          message: "Request body must be valid JSON."
        }
      },
      400,
      request,
      env
    );
  }

  const validation = validateCheckoutRequest(body);
  if (!validation.valid) {
    return json(
      {
        error: {
          code: "invalid_input",
          message: validation.message
        }
      },
      400,
      request,
      env
    );
  }

  try {
    const checkout = createMerchantCheckoutLink(validation.data, env);
    await saveCheckoutOrder(validation.data, checkout, env);
    return json(checkout, 200, request, env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Checkout link creation failed.";
    return json(
      {
        error: {
          code: "checkout_error",
          message
        }
      },
      502,
      request,
      env
    );
  }
}

async function handleAdminLedger(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return json(
      {
        error: {
          code: "method_not_allowed",
          message: "Use GET for this endpoint."
        }
      },
      405,
      request,
      env
    );
  }

  const auth = authenticateAdmin(request, env);
  if (!auth.valid) return json({ error: auth.error }, auth.status, request, env);
  if (!env.DB) {
    return json({ error: { code: "db_unavailable", message: "D1 is not configured." } }, 500, request, env);
  }

  const url = new URL(request.url);
  const payoutStatus = url.searchParams.get("payoutStatus");
  const allowedStatuses = new Set(["pending", "paid", "cancelled"]);
  const filter = payoutStatus && allowedStatuses.has(payoutStatus) ? payoutStatus : null;

  const orders = filter
    ? await env.DB.prepare(
        `SELECT
          orders.id,
          orders.case_reference_id,
          doctor_requests.doctor_id,
          doctor_requests.patient_email,
          doctor_requests.note,
          orders.payment_provider,
          orders.provider_checkout_id,
          orders.gross_amount_usd,
          orders.platform_fee_rate_bps,
          orders.platform_fee_usd,
          orders.doctor_payout_usd,
          orders.status,
          orders.service_status,
          orders.payout_status,
          orders.payout_method,
          orders.payout_reference,
          orders.paid_out_at,
          orders.created_at
        FROM orders
        LEFT JOIN doctor_requests ON doctor_requests.id = orders.doctor_request_id
        WHERE orders.payout_status = ?
        ORDER BY orders.id DESC
        LIMIT 100`
      )
        .bind(filter)
        .all()
    : await env.DB.prepare(
        `SELECT
          orders.id,
          orders.case_reference_id,
          doctor_requests.doctor_id,
          doctor_requests.patient_email,
          doctor_requests.note,
          orders.payment_provider,
          orders.provider_checkout_id,
          orders.gross_amount_usd,
          orders.platform_fee_rate_bps,
          orders.platform_fee_usd,
          orders.doctor_payout_usd,
          orders.status,
          orders.service_status,
          orders.payout_status,
          orders.payout_method,
          orders.payout_reference,
          orders.paid_out_at,
          orders.created_at
        FROM orders
        LEFT JOIN doctor_requests ON doctor_requests.id = orders.doctor_request_id
        ORDER BY orders.id DESC
        LIMIT 100`
      ).all();

  const totals = await env.DB.prepare(
    `SELECT
      COALESCE(SUM(gross_amount_usd), 0) AS gross_amount_usd,
      COALESCE(SUM(platform_fee_usd), 0) AS platform_fee_usd,
      COALESCE(SUM(doctor_payout_usd), 0) AS doctor_payout_usd,
      COALESCE(SUM(CASE WHEN payout_status = 'pending' THEN doctor_payout_usd ELSE 0 END), 0) AS pending_doctor_payout_usd,
      COALESCE(SUM(CASE WHEN payout_status = 'paid' THEN doctor_payout_usd ELSE 0 END), 0) AS paid_doctor_payout_usd
    FROM orders`
  ).first();

  return json(
    {
      totals,
      orders: orders.results
    },
    200,
    request,
    env
  );
}

async function handleAdminMarkPayout(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return json(
      {
        error: {
          code: "method_not_allowed",
          message: "Use POST for this endpoint."
        }
      },
      405,
      request,
      env
    );
  }

  const auth = authenticateAdmin(request, env);
  if (!auth.valid) return json({ error: auth.error }, auth.status, request, env);
  if (!env.DB) {
    return json({ error: { code: "db_unavailable", message: "D1 is not configured." } }, 500, request, env);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(
      { error: { code: "invalid_json", message: "Request body must be valid JSON." } },
      400,
      request,
      env
    );
  }

  const validation = validateMarkPayoutRequest(body);
  if (!validation.valid) {
    return json(
      { error: { code: "invalid_input", message: validation.message } },
      400,
      request,
      env
    );
  }

  const result = await env.DB.prepare(
    `UPDATE orders
    SET payout_status = 'paid',
        payout_method = ?,
        payout_reference = ?,
        paid_out_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`
  )
    .bind(
      validation.data.payoutMethod ?? "manual",
      validation.data.payoutReference ?? null,
      validation.data.orderId
    )
    .run();

  if (result.meta.changes === 0) {
    return json(
      { error: { code: "not_found", message: "Order not found." } },
      404,
      request,
      env
    );
  }

  await env.DB.prepare(
    "INSERT INTO ledger_events (order_id, event_type, metadata) VALUES (?, ?, ?)"
  )
    .bind(
      validation.data.orderId,
      "doctor_payout_marked_paid",
      JSON.stringify({
        payoutMethod: validation.data.payoutMethod ?? "manual",
        payoutReference: validation.data.payoutReference ?? null
      })
    )
    .run();

  return json({ ok: true }, 200, request, env);
}

function validateCheckoutRequest(input: unknown):
  | { valid: true; data: CheckoutRequest }
  | { valid: false; message: string } {
  if (typeof input !== "object" || input === null) {
    return { valid: false, message: "Request body must be an object." };
  }

  const data = input as Partial<CheckoutRequest>;
  if (typeof data.doctorId !== "string" || data.doctorId.trim().length < 3) {
    return { valid: false, message: "doctorId is required." };
  }

  if (typeof data.doctorName !== "string" || data.doctorName.trim().length < 3) {
    return { valid: false, message: "doctorName is required." };
  }

  if (
    typeof data.amountUsd !== "number" ||
    !Number.isFinite(data.amountUsd) ||
    data.amountUsd < 1 ||
    data.amountUsd > 10000
  ) {
    return { valid: false, message: "amountUsd must be a valid positive number." };
  }

  const email =
    typeof data.patientEmail === "string" && data.patientEmail.includes("@")
      ? data.patientEmail.trim().slice(0, 254)
      : undefined;

  return {
    valid: true,
    data: {
      doctorId: data.doctorId.trim().slice(0, 80),
      doctorName: data.doctorName.trim().slice(0, 120),
      amountUsd: Math.round(data.amountUsd),
      patientEmail: email,
      caseReferenceId:
        typeof data.caseReferenceId === "string" && data.caseReferenceId.trim().length > 0
          ? data.caseReferenceId.trim().slice(0, 80)
          : undefined
    }
  };
}

function validateMarkPayoutRequest(input: unknown):
  | { valid: true; data: MarkPayoutRequest }
  | { valid: false; message: string } {
  if (typeof input !== "object" || input === null) {
    return { valid: false, message: "Request body must be an object." };
  }

  const data = input as Partial<MarkPayoutRequest>;
  if (
    typeof data.orderId !== "number" ||
    !Number.isInteger(data.orderId) ||
    data.orderId <= 0
  ) {
    return { valid: false, message: "orderId must be a positive integer." };
  }

  return {
    valid: true,
    data: {
      orderId: data.orderId,
      payoutMethod:
        typeof data.payoutMethod === "string" && data.payoutMethod.trim().length > 0
          ? data.payoutMethod.trim().slice(0, 80)
          : undefined,
      payoutReference:
        typeof data.payoutReference === "string" && data.payoutReference.trim().length > 0
          ? data.payoutReference.trim().slice(0, 160)
          : undefined
    }
  };
}

function createMerchantCheckoutLink(
  input: CheckoutRequest,
  env: Env
): CheckoutResponse {
  if (!env.PAYMENT_CHECKOUT_URL) {
    throw new Error("PAYMENT_CHECKOUT_URL is not configured.");
  }

  const checkoutUrl = new URL(env.PAYMENT_CHECKOUT_URL);
  checkoutUrl.searchParams.set("doctor_id", input.doctorId);
  checkoutUrl.searchParams.set("doctor_name", input.doctorName);
  checkoutUrl.searchParams.set("amount_usd", String(input.amountUsd));
  checkoutUrl.searchParams.set("provider", env.PAYMENT_PROVIDER ?? "merchant_of_record");
  if (input.caseReferenceId) checkoutUrl.searchParams.set("case_reference_id", input.caseReferenceId);
  if (input.patientEmail) checkoutUrl.searchParams.set("patient_email", input.patientEmail);

  return {
    checkoutUrl: checkoutUrl.toString(),
    sessionId: `mor_${crypto.randomUUID()}`,
    accounting: calculateAccountingSplit(input.amountUsd)
  };
}

function calculateAccountingSplit(grossAmountUsd: number): AccountingSplit {
  const platformFeeUsd = Math.round((grossAmountUsd * PLATFORM_FEE_RATE_BPS) / 10000);
  return {
    grossAmountUsd,
    platformFeeRateBps: PLATFORM_FEE_RATE_BPS,
    platformFeeUsd,
    doctorPayoutUsd: grossAmountUsd - platformFeeUsd
  };
}

async function saveCheckoutOrder(
  input: CheckoutRequest,
  checkout: CheckoutResponse,
  env: Env
): Promise<void> {
  if (!env.DB) return;

  const doctorRequest = await env.DB.prepare(
    `INSERT INTO doctor_requests (
      case_reference_id,
      doctor_id,
      patient_email,
      status,
      note
    ) VALUES (?, ?, ?, ?, ?)
    RETURNING id`
  )
    .bind(
      input.caseReferenceId ?? null,
      input.doctorId,
      input.patientEmail ?? null,
      "checkout_link_created",
      `Requested ${input.doctorName}`
    )
    .first<{ id: number }>();

  await env.DB.prepare(
    `INSERT INTO orders (
      case_reference_id,
      doctor_request_id,
      payment_provider,
      provider_checkout_id,
      provider_checkout_url,
      amount_usd,
      gross_amount_usd,
      platform_fee_rate_bps,
      platform_fee_usd,
      doctor_payout_usd,
      payout_status,
      service_status,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.caseReferenceId ?? null,
      doctorRequest?.id ?? null,
      env.PAYMENT_PROVIDER ?? "merchant_of_record",
      checkout.sessionId,
      checkout.checkoutUrl,
      input.amountUsd,
      checkout.accounting.grossAmountUsd,
      checkout.accounting.platformFeeRateBps,
      checkout.accounting.platformFeeUsd,
      checkout.accounting.doctorPayoutUsd,
      "pending",
      "pending_confirmation",
      "checkout_link_created"
    )
    .run()
    .then(async (result) => {
      if (!env.DB) return;
      await env.DB.prepare(
        "INSERT INTO ledger_events (order_id, event_type, amount_usd, metadata) VALUES (?, ?, ?, ?)"
      )
        .bind(
          result.meta.last_row_id,
          "checkout_link_created",
          checkout.accounting.grossAmountUsd,
          JSON.stringify({
            platformFeeUsd: checkout.accounting.platformFeeUsd,
            doctorPayoutUsd: checkout.accounting.doctorPayoutUsd,
            platformFeeRateBps: checkout.accounting.platformFeeRateBps
          })
        )
        .run();
    });
}

function validateRequest(input: unknown):
  | { valid: true; data: AnalyzeSymptomsRequest }
  | { valid: false; message: string } {
  if (typeof input !== "object" || input === null) {
    return { valid: false, message: "Request body must be an object." };
  }

  const data = input as Partial<AnalyzeSymptomsRequest>;
  const severities: Severity[] = ["mild", "moderate", "severe"];
  const durationUnits: DurationUnit[] = ["hours", "days", "weeks", "months"];

  if (typeof data.symptoms !== "string" || data.symptoms.trim().length < 10) {
    return {
      valid: false,
      message: "symptoms must be a string with at least 10 characters."
    };
  }

  if (!data.severity || !severities.includes(data.severity)) {
    return { valid: false, message: "severity must be one of mild, moderate, severe." };
  }

  if (
    typeof data.durationValue !== "number" ||
    !Number.isFinite(data.durationValue) ||
    data.durationValue <= 0
  ) {
    return { valid: false, message: "durationValue must be a positive number." };
  }

  if (!data.durationUnit || !durationUnits.includes(data.durationUnit)) {
    return {
      valid: false,
      message: "durationUnit must be one of hours, days, weeks, months."
    };
  }

  const imageFields =
    typeof data.imageBase64 === "string" && typeof data.imageMimeType === "string"
      ? {
          imageBase64: data.imageBase64,
          imageMimeType: data.imageMimeType
        }
      : {};

  return {
    valid: true,
    data: {
      symptoms: data.symptoms.trim(),
      severity: data.severity,
      durationValue: data.durationValue,
      durationUnit: data.durationUnit,
      outputLanguage:
        typeof data.outputLanguage === "string" && data.outputLanguage.trim().length > 0
          ? data.outputLanguage.trim().slice(0, 40)
          : "English",
      ...imageFields
    }
  };
}

async function callGemini(input: AnalyzeSymptomsRequest, env: Env): Promise<AnalyzeSymptomsResponse> {
  const model = env.GEMINI_MODEL ?? "gemini-2.5-flash-lite";
  const baseUrl = (env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com").replace(
    /\/$/,
    ""
  );

  const prompt = [
    "You are a medical triage assistant.",
    "You must NOT provide diagnosis, certainty claims, prescriptions, or treatment plans.",
    "If an image is provided, use it only as visual context and do not diagnose from it.",
    "Return triage support only: risk level, department suggestions, and safe next steps.",
    "Include explicit escalation if high-risk signals are possible.",
    "Keep response concise, practical, and patient-friendly.",
    `Write summary, recommendedDepartments, and nextSteps in this language: ${input.outputLanguage ?? "English"}.`,
    "Output JSON with keys: riskLevel, summary, recommendedDepartments, nextSteps.",
    "riskLevel must be one of low|medium|high.",
    "Do not wrap JSON in markdown fences.",
    "",
    "Input:",
    JSON.stringify({
      symptoms: input.symptoms,
      severity: input.severity,
      durationValue: input.durationValue,
      durationUnit: input.durationUnit,
      outputLanguage: input.outputLanguage ?? "English",
      hasImage: Boolean(input.imageBase64)
    })
  ].join("\n");

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: prompt }
  ];

  if (input.imageBase64 && input.imageMimeType) {
    parts.push({
      inlineData: {
        mimeType: input.imageMimeType,
        data: input.imageBase64
      }
    });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  const response = await fetch(
    `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts
          }
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json"
        }
      }),
      signal: controller.signal
    }
  ).finally(() => clearTimeout(timeoutId));

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${details.slice(0, 300)}`);
  }

  const payload = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };

  const content = payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!content) {
    throw new Error("Gemini returned an empty response.");
  }

  let parsed: {
    riskLevel?: string;
    summary?: string;
    recommendedDepartments?: string[];
    nextSteps?: string[];
  };

  try {
    parsed = JSON.parse(extractJson(content)) as typeof parsed;
  } catch {
    throw new Error("Gemini returned non-JSON content.");
  }

  const riskLevel = normalizeRiskLevel(parsed.riskLevel);
  const summary = typeof parsed.summary === "string" ? parsed.summary : "No summary generated.";
  const recommendedDepartments = normalizeStringArray(parsed.recommendedDepartments);
  const nextSteps = normalizeStringArray(parsed.nextSteps);

  return {
    riskLevel,
    summary,
    recommendedDepartments:
      recommendedDepartments.length > 0 ? recommendedDepartments : ["General Medicine"],
    nextSteps:
      nextSteps.length > 0
        ? nextSteps
        : [
            "Book a licensed clinician for full evaluation.",
            "Monitor symptom changes and seek urgent care if symptoms worsen."
          ],
    disclaimer: DISCLAIMER,
    referenceId: generateReferenceId()
  };
}

async function saveCase(
  input: AnalyzeSymptomsRequest,
  result: AnalyzeSymptomsResponse,
  env: Env
): Promise<void> {
  if (!env.DB) return;

  await env.DB.prepare(
    `INSERT INTO cases (
      reference_id,
      symptoms,
      severity,
      duration_value,
      duration_unit,
      output_language,
      risk_level,
      summary,
      recommended_departments,
      next_steps
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      result.referenceId,
      createMinimizedSymptomRecord(input.symptoms),
      input.severity,
      input.durationValue,
      input.durationUnit,
      input.outputLanguage ?? "English",
      result.riskLevel,
      result.summary,
      JSON.stringify(result.recommendedDepartments),
      JSON.stringify(result.nextSteps)
    )
    .run();
}

function createMinimizedSymptomRecord(symptoms: string): string {
  return `[redacted_symptom_text length=${symptoms.trim().length}]`;
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return raw;
}

function normalizeRiskLevel(value: string | undefined): RiskLevel {
  if (value === "low" || value === "high" || value === "medium") return value;
  return "medium";
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function generateReferenceId(): string {
  const now = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(2, 14);
  const suffix = crypto.randomUUID().slice(0, 6).toUpperCase();
  return `AHM-${now}-${suffix}`;
}

async function withApiLog(
  request: Request,
  env: Env,
  route: string,
  handler: () => Promise<Response>
): Promise<Response> {
  const started = Date.now();
  const response = await handler();
  await logApiEvent(request, env, route, response.status, Date.now() - started);
  return response;
}

async function enforceRateLimit(
  request: Request,
  env: Env,
  route: string,
  maxRequests: number
): Promise<{ allowed: boolean }> {
  if (!env.DB) return { allowed: true };

  const clientHash = await hashClient(request);
  const windowStart =
    Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SECONDS) * RATE_LIMIT_WINDOW_SECONDS;
  const key = `${route}:${clientHash}:${windowStart}`;

  const current = await env.DB.prepare("SELECT request_count FROM api_rate_limits WHERE key = ?")
    .bind(key)
    .first<{ request_count: number }>();

  if (current && current.request_count >= maxRequests) {
    return { allowed: false };
  }

  if (current) {
    await env.DB.prepare(
      "UPDATE api_rate_limits SET request_count = request_count + 1, updated_at = CURRENT_TIMESTAMP WHERE key = ?"
    )
      .bind(key)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO api_rate_limits (key, client_hash, route, window_start, request_count) VALUES (?, ?, ?, ?, 1)"
    )
      .bind(key, clientHash, route, windowStart)
      .run();
  }

  return { allowed: true };
}

async function logApiEvent(
  request: Request,
  env: Env,
  route: string,
  status: number,
  durationMs: number
): Promise<void> {
  if (!env.DB) return;

  await env.DB.prepare(
    "INSERT INTO api_logs (route, method, status, client_hash, duration_ms) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(route, request.method, status, await hashClient(request), Math.max(0, durationMs))
    .run();
}

async function hashClient(request: Request): Promise<string> {
  const ip =
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ??
    "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function authenticateAdmin(request: Request, env: Env):
  | { valid: true }
  | { valid: false; status: number; error: { code: string; message: string } } {
  if (!env.ADMIN_API_TOKEN) {
    return {
      valid: false,
      status: 500,
      error: {
        code: "config_error",
        message: "ADMIN_API_TOKEN is not configured."
      }
    };
  }

  const expected = `Bearer ${env.ADMIN_API_TOKEN}`;
  if (request.headers.get("Authorization") !== expected) {
    return {
      valid: false,
      status: 401,
      error: {
        code: "unauthorized",
        message: "Missing or invalid admin token."
      }
    };
  }

  return { valid: true };
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get("Origin");
  const allowedOrigins = new Set([
    env.FRONTEND_BASE_URL ?? "https://healthmatchai.com",
    "https://healthmatchai.com",
    "https://www.healthmatchai.com",
    "https://ai-health-frontend.pages.dev",
    "http://localhost:3000"
  ]);

  return {
    "Access-Control-Allow-Origin":
      origin && allowedOrigins.has(origin) ? origin : "https://healthmatchai.com",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin"
  };
}

function json(data: unknown, status = 200, request?: Request, env?: Env): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(request && env
        ? corsHeaders(request, env)
        : {
            "Access-Control-Allow-Origin": "https://healthmatchai.com",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization"
          })
    }
  });
}
