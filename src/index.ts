type Severity = "mild" | "moderate" | "severe";
type DurationUnit = "hours" | "days" | "weeks" | "months";
type RiskLevel = "low" | "medium" | "high";

type AnalyzeSymptomsRequest = {
  symptoms: string;
  severity: Severity;
  durationValue: number;
  durationUnit: DurationUnit;
};

type AnalyzeSymptomsResponse = {
  riskLevel: RiskLevel;
  summary: string;
  recommendedDepartments: string[];
  nextSteps: string[];
  disclaimer: string;
  referenceId: string;
};

interface Env {
  DEEPSEEK_API_KEY: string;
  DEEPSEEK_MODEL?: string;
  DEEPSEEK_BASE_URL?: string;
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

    if (url.pathname !== "/api/analyze-symptoms") {
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

    if (!env.DEEPSEEK_API_KEY) {
      return json(
        {
          error: {
            code: "config_error",
            message: "DEEPSEEK_API_KEY is not configured."
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
      const aiResult = await callDeepSeek(validation.data, env);
      return json(aiResult, 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : "DeepSeek request failed.";
      return json(
        {
          error: {
            code: "deepseek_error",
            message
          }
        },
        502
      );
    }
  }
};

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

  return {
    valid: true,
    data: {
      symptoms: data.symptoms.trim(),
      severity: data.severity,
      durationValue: data.durationValue,
      durationUnit: data.durationUnit
    }
  };
}

async function callDeepSeek(input: AnalyzeSymptomsRequest, env: Env): Promise<AnalyzeSymptomsResponse> {
  const model = env.DEEPSEEK_MODEL ?? "deepseek-chat";
  const baseUrl = (env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, "");

  const prompt = [
    "You are a medical triage assistant.",
    "You must NOT provide diagnosis, certainty claims, prescriptions, or treatment plans.",
    "Return triage support only: risk level, department suggestions, and safe next steps.",
    "Include explicit escalation if high-risk signals are possible.",
    "Keep response concise, practical, and patient-friendly.",
    "",
    "Input:",
    JSON.stringify(input)
  ].join("\n");

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: [
            "Output JSON with keys: riskLevel, summary, recommendedDepartments, nextSteps. " +
              "riskLevel must be one of low|medium|high.",
            "Do not wrap JSON in markdown fences."
          ].join(" ")
        },
        {
          role: "user",
          content: prompt
        }
      ],
      temperature: 0.2
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`DeepSeek API error (${response.status}): ${details.slice(0, 300)}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("DeepSeek returned an empty response.");
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
    throw new Error("DeepSeek returned non-JSON content.");
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
