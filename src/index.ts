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
};

interface Env {
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  GEMINI_BASE_URL?: string;
  FRONTEND_BASE_URL?: string;
  PAYMENT_CHECKOUT_URL?: string;
  PAYMENT_PROVIDER?: string;
  DB?: D1Database;
}

const DISCLAIMER =
  "Medical disclaimer: This output is AI-generated triage support, not a diagnosis. " +
  "Always consult a licensed clinician. If symptoms are severe, worsening, or life-threatening, seek emergency care.";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname === "/api/analyze-symptoms") {
      return handleAnalyzeSymptoms(request, env);
    }

    if (url.pathname === "/api/create-checkout-session") {
      return handleCreateCheckoutSession(request, env);
    }

    return json(
      {
        error: {
          code: "not_found",
          message: "Route not found."
        }
      },
      404
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
      405
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
      500
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
      400
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
      400
    );
  }

  try {
    const aiResult = await callGemini(validation.data, env);
    await saveCase(validation.data, aiResult, env);
    return json(aiResult, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Gemini request failed.";
    return json(
      {
        error: {
          code: "gemini_error",
          message
        }
      },
      502
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
      405
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
      500
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
      400
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
      400
    );
  }

  try {
    const checkout = createMerchantCheckoutLink(validation.data, env);
    await saveCheckoutOrder(validation.data, checkout, env);
    return json(checkout, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Checkout link creation failed.";
    return json(
      {
        error: {
          code: "checkout_error",
          message
        }
      },
      502
    );
  }
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
    sessionId: `mor_${crypto.randomUUID()}`
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
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      input.caseReferenceId ?? null,
      doctorRequest?.id ?? null,
      env.PAYMENT_PROVIDER ?? "merchant_of_record",
      checkout.sessionId,
      checkout.checkoutUrl,
      input.amountUsd,
      "checkout_link_created"
    )
    .run();
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
      input.symptoms,
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders
    }
  });
}
