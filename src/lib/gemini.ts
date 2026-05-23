/**
 * Gemini API wrapper.
 * API key is sent via x-goog-api-key header, never in URL query params.
 */

export interface GeminiInput {
  symptoms: string;
  severity: string;
  durationValue: number;
  durationUnit: string;
  outputLanguage?: string;
}

export interface GeminiTriageOutput {
  plainLanguageExplanation: string;
  doctorReadySummary: string;
  possibleCauses: string[];
  questionsToAskClinician: string[];
  coverageQuestions: string[];
}

const ALLOWED_CARE_LEVELS = [
  "Emergency",
  "Urgent Care",
  "Primary Care",
  "Telehealth",
  "Pharmacy/Self-care",
  "Monitor at home",
];

const FORBIDDEN_PATTERNS = [
  /\bdiagnosed with\b/i,
  /\byou have\s+(?!a question\b|a concern\b|symptoms\b|an? )/i,
  /\bcertainly\s+(?:is|are|has)\b/i,
  /\bno need to (?:see|visit|consult|seek|call)\b/i,
  /\bdo not need (?:medical|to see|cancer|treatment|medication)\b/i,
  /\bprescribed?\s+(?:\w+\s)?(?:mg|mcg|ml|tablet|capsule|pill|dose|dosage)\b/i,
  /\brecommend\s+(?:\w+\s+){0,3}(?:insurance|plan|carrier)\b/i,
  /\bbest insurance\b/i,
  /\btake\s+\d+\s*(?:mg|mcg|ml|tablet|capsule|pill)\b/i,
  /\bdefinitely (?:is|has|will|won't|cancer|benign|malignant|serious|not serious)\b/i,
];

const PREFIX_POSSIBLE_CAUSE = "Possible: ";

export function containsForbiddenContent(text: string): string | null {
  for (const pattern of FORBIDDEN_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

function sanitizeText(text: string): string {
  let sanitized = text;
  for (const pattern of FORBIDDEN_PATTERNS) {
    sanitized = sanitized.replace(
      new RegExp(pattern.source, pattern.flags),
      "[content removed by safety filter]"
    );
  }
  return sanitized;
}

const SYSTEM_PROMPT = [
  "You are an AI health triage and care navigation assistant.",
  "You MUST NOT provide diagnosis, certainty claims, prescriptions, treatment plans, or insurance advice.",
  "You MUST NOT tell anyone they do not need to seek care.",
  "You MUST NOT recommend specific insurance plans, carriers, or products.",
  "Your role is educational: help users understand possible causes (framed as possibilities to discuss with a clinician), prepare summaries for doctor visits, and suggest coverage questions.",
  "Always use cautious, non-diagnostic language.",
  "If serious symptoms are described, always recommend seeking professional medical evaluation.",
  "Do not wrap JSON in markdown fences.",
].join("\n");

function buildPrompt(input: GeminiInput, riskLevel: string, recommendedCare: string, redFlags: string[]): string {
  return [
    SYSTEM_PROMPT,
    "",
    "A rule-based triage system has already assessed this case:",
    `Risk level: ${riskLevel}`,
    `Recommended care: ${recommendedCare}`,
    `Red flags found: ${redFlags.length > 0 ? redFlags.join(", ") : "None"}`,
    "",
    "Your job:",
    "1. Provide a plain-language explanation of what these symptoms might mean (framed as possibilities, not diagnoses).",
    "2. Write a doctor-ready summary the user can share with a clinician.",
    "3. List possible causes to discuss with a clinician (2-5 items, cautious language).",
    "4. Suggest questions the user should ask their clinician.",
    "5. Suggest insurance coverage questions relevant to the recommended care level.",
    "",
    `Write in this language: ${input.outputLanguage || "English"}.`,
    "",
    "Output JSON with keys: plainLanguageExplanation, doctorReadySummary, possibleCauses, questionsToAskClinician, coverageQuestions.",
    "possibleCauses, questionsToAskClinician, and coverageQuestions must be arrays of strings.",
    "Each possible cause must start with 'Possible: ' or similar cautious phrasing.",
    "Do NOT include: diagnosis, prescription, dosage, treatment plan, guarantee, or 'no need to seek care'.",
    "",
    "Patient input:",
    JSON.stringify({
      symptoms: input.symptoms,
      severity: input.severity,
      durationValue: input.durationValue,
      durationUnit: input.durationUnit,
    }),
  ].join("\n");
}

export async function generateTriageContent(
  input: GeminiInput,
  riskLevel: string,
  recommendedCare: string,
  redFlags: string[],
  apiKey: string,
  model?: string,
  baseUrl?: string
): Promise<GeminiTriageOutput> {
  const modelName = model || "gemini-2.5-flash-lite";
  const apiBaseUrl = (baseUrl || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
  const prompt = buildPrompt(input, riskLevel, recommendedCare, redFlags);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(
      `${apiBaseUrl}/v1beta/models/${encodeURIComponent(modelName)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: "application/json",
          },
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new Error(`Gemini API error (${response.status}): ${details.slice(0, 200)}`);
    }

    const payload = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };

    const content = payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim();

    if (!content) {
      throw new Error("Gemini returned an empty response.");
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(extractJson(content)) as Record<string, unknown>;
    } catch {
      throw new Error("Gemini returned non-JSON content.");
    }

    const explanation = typeof parsed.plainLanguageExplanation === "string"
      ? parsed.plainLanguageExplanation
      : "";
    const summary = typeof parsed.doctorReadySummary === "string"
      ? parsed.doctorReadySummary
      : "";
    const causes = normalizeStringArray(parsed.possibleCauses, []);
    const questions = normalizeStringArray(parsed.questionsToAskClinician, []);
    const coverage = normalizeStringArray(parsed.coverageQuestions, []);

    // Safety: scan for forbidden content
    const allText = [explanation, summary, ...causes, ...questions, ...coverage].join(" ");
    const forbiddenHit = containsForbiddenContent(allText);
    if (forbiddenHit) {
      console.warn("Gemini safety filter triggered. Forbidden content:", forbiddenHit);
    }

    // Enforce "Possible: " prefix on causes
    const safeCauses = causes.map((c) =>
      c.startsWith(PREFIX_POSSIBLE_CAUSE) ? c : PREFIX_POSSIBLE_CAUSE + c
    );

    return {
      plainLanguageExplanation:
        explanation && !containsForbiddenContent(explanation)
          ? explanation
          : sanitizeText(explanation) || "Unable to generate explanation. Please discuss your symptoms with a licensed clinician.",
      doctorReadySummary:
        summary && !containsForbiddenContent(summary)
          ? summary
          : sanitizeText(summary) || "Please share your symptoms, severity, duration, and any changes with a licensed clinician.",
      possibleCauses: safeCauses.length > 0 ? safeCauses : [
        "Several causes are possible; a licensed clinician can evaluate based on exam and history.",
      ],
      questionsToAskClinician: questions.filter((q) => !containsForbiddenContent(q)).length > 0
        ? questions.filter((q) => !containsForbiddenContent(q))
        : [
          "What might be causing my symptoms?",
          "What tests or exams do you recommend?",
          "What symptoms would make this urgent?",
        ],
      coverageQuestions: coverage.filter((q) => !containsForbiddenContent(q)).length > 0
        ? coverage.filter((q) => !containsForbiddenContent(q))
        : [
          "What is my copay for this type of visit?",
          "Is this provider in-network?",
          "Do I need a referral or prior authorization?",
        ],
    };
  } finally {
    clearTimeout(timeoutId);
  }
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

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const filtered = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0
  );
  return filtered.length > 0 ? filtered : fallback;
}
