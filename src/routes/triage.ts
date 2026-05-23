/**
 * Triage route: runs rule engine, optionally calls Gemini for AI content.
 * Emergency/Crisis results cannot be downgraded by AI.
 */

import type { D1Database } from "@cloudflare/workers-types";
import { evalTriage, escalationAdvice } from "../lib/triage-engine";
import { generateTriageContent } from "../lib/gemini";
import { encryptJson } from "../lib/crypto";
import { optionalSession } from "../lib/session";
import { AppError, jsonResponse, badRequest } from "../lib/errors";
import type { TriageApiRequest, TriageApiResponse } from "../types";

interface Env {
  DB?: D1Database;
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  GEMINI_BASE_URL?: string;
  DATA_ENCRYPTION_KEY?: string;
}

// ---------- Handler ----------

export async function handleTriage(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    throw new AppError(405, "method_not_allowed", "Use POST for this endpoint.");
  }

  let body: TriageApiRequest;
  try {
    body = (await request.json()) as TriageApiRequest;
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }

  if (!body.symptoms || !Array.isArray(body.symptoms) || body.symptoms.length === 0) {
    throw badRequest("At least one symptom is required.");
  }

  const triage = evalTriage(body);

  let aiContent: {
    plainLanguageExplanation: string;
    doctorReadySummary: string;
    possibleCauses: string[];
    questionsToAskClinician: string[];
    coverageQuestions: string[];
  } | null = null;

  let aiReviewStatus: "generated" | "fallback" | "unavailable" = "unavailable";

  if (env.GEMINI_API_KEY && !triage.isEmergency) {
    try {
      aiContent = await generateTriageContent(
        {
          symptoms: body.symptoms.join(", "),
          severity: body.severity,
          durationValue: body.duration === "lessThan24h" ? 0.5 : body.duration === "oneToThreeDays" ? 2 : body.duration === "fourToSevenDays" ? 5 : body.duration === "moreThanSevenDays" ? 10 : 14,
          durationUnit: "days",
          outputLanguage: body.outputLanguage || "English",
        },
        triage.riskLevel,
        triage.recommendedCare,
        triage.redFlagsFound,
        env.GEMINI_API_KEY,
        env.GEMINI_MODEL,
        env.GEMINI_BASE_URL
      );
      aiReviewStatus = "generated";
    } catch (error) {
      console.error("Gemini triage failed:", error instanceof Error ? error.message : String(error));
      aiReviewStatus = "fallback";
    }
  } else if (env.GEMINI_API_KEY && triage.isEmergency) {
    aiReviewStatus = "unavailable";
  }

  const referenceId = `AHM-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(2, 14)}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;

  const response: TriageApiResponse = {
    riskLevel: triage.riskLevel,
    recommendedCare: triage.recommendedCare,
    score: triage.score,
    reasons: triage.reasons,
    redFlagsFound: triage.redFlagsFound,
    possibleCauses: aiContent?.possibleCauses || ["Several causes are possible; a licensed clinician can evaluate based on exam and history."],
    whatToMonitor: ["Fever or temperature changes", "Breathing difficulty", "Hydration and urination", "Worsening fatigue or weakness", "Symptoms lasting longer than expected"],
    escalationAdvice: escalationAdvice(triage.riskLevel),
    doctorReadySummary: aiContent?.doctorReadySummary || "Please share your symptoms, severity, duration, and any changes with a licensed clinician.",
    plainLanguageExplanation: aiContent?.plainLanguageExplanation || "Your symptoms have been assessed. Please discuss the results with a healthcare provider.",
    questionsToAskClinician: aiContent?.questionsToAskClinician || ["What might be causing my symptoms?", "What tests or exams do you recommend?"],
    coverageQuestions: aiContent?.coverageQuestions || ["What is my copay for this type of visit?", "Is this provider in-network?"],
    disclaimer: "HealthMatchAI does not diagnose, prescribe, treat, or replace professional medical care. This is educational guidance only.",
    referenceId,
    aiReviewStatus,
  };

  // Save for logged-in users
  const session = await optionalSession(env.DB as D1Database, request.headers.get("Cookie"));

  if (session && env.DB && env.DATA_ENCRYPTION_KEY) {
    try {
      const encrypted = await encryptJson({ input: body, result: response }, env.DATA_ENCRYPTION_KEY);
      await env.DB.prepare(
        `INSERT INTO symptom_checks (id, user_id, risk_level, recommended_care, primary_concern, encrypted_payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(referenceId, session.user.id, triage.riskLevel, triage.recommendedCare, body.primaryConcern || body.primarySymptom || "", encrypted, new Date().toISOString(), new Date().toISOString()).run();
    } catch (error) {
      console.error("Failed to save symptom check:", error instanceof Error ? error.message : String(error));
    }
  }

  return jsonResponse(response);
}
