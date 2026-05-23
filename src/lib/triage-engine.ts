/**
 * Triage rule engine — standalone module for testability.
 * Emergency/Crisis results must never be downgraded by AI or any later step.
 */

import type { TriageApiRequest, TriageRiskLevel, TriageRecommendedCare } from "../types";

const EMERGENCY_RED_FLAGS = new Set([
  "chestPainOrPressure", "troubleBreathing", "confusion", "hardToWake",
  "seizure", "fainting", "strokeLikeSymptoms", "severeAllergicReaction",
  "blueOrGrayLips", "severeBleeding",
]);

const CRISIS_SYMPTOMS = new Set(["suicidalthoughts", "selfharmthoughts"]);

const DURATION_SCORES: Record<string, number> = {
  lessThan24h: 0, oneToThreeDays: 0, fourToSevenDays: 1, moreThanSevenDays: 2, moreThanTwoWeeks: 3,
};
const TREND_SCORES: Record<string, number> = {
  gettingBetter: 0, unchanged: 1, gettingWorse: 2, improvedThenWorsened: 3,
};
const SEVERITY_SCORES: Record<string, number> = { mild: 0, moderate: 1, severe: 3 };
const IMPACT_SCORES: Record<string, number> = {
  sleepAffected: 1, eatingDrinkingAffected: 2, unableToWorkOrWalkNormally: 2,
  hardToStayAwake: 3, veryWeakOrUnsteady: 2, notUrinatingOrVeryLittle: 3,
};
const BACKGROUND_SCORES: Record<string, number> = {
  pregnantOrPossiblyPregnant: 2, child: 2, olderAdult: 2, immunocompromised: 3,
  heartDisease: 2, diabetes: 2, asthmaOrChronicLungDisease: 2, kidneyDisease: 2, recentSurgery: 2,
};

export interface TriageResult {
  riskLevel: TriageRiskLevel;
  recommendedCare: TriageRecommendedCare;
  score: number;
  reasons: string[];
  redFlagsFound: string[];
  isEmergency: boolean;
}

export function evalTriage(input: TriageApiRequest): TriageResult {
  const symptoms = input.symptoms.map((s) => s.toLowerCase().replace(/-/g, ""));
  const redFlags = new Set(input.redFlags || []);
  const functionImpact = input.functionImpact || [];
  const reasons: string[] = [];

  const isCrisis = symptoms.some((s) => CRISIS_SYMPTOMS.has(s)) ||
    redFlags.has("suicidalThoughts") || redFlags.has("selfHarmThoughts");
  if (isCrisis) {
    return {
      riskLevel: "Crisis", recommendedCare: "Crisis support now", score: 99,
      reasons: ["You reported thoughts of self-harm or suicide. This requires immediate support."],
      redFlagsFound: Array.from(redFlags), isEmergency: true,
    };
  }

  const hasChestPain = symptoms.includes("chestpain") || symptoms.includes("chesttightness") || redFlags.has("chestPainOrPressure");
  const hasBreathing = symptoms.includes("shortnessofbreath") || redFlags.has("troubleBreathing");
  const hasNeuroEmergency = symptoms.some((s) => ["confusion", "seizure", "fainting", "troublespeaking"].includes(s));

  if ((hasChestPain && hasBreathing) || hasNeuroEmergency) {
    return {
      riskLevel: "Emergency", recommendedCare: "Emergency care now", score: 99,
      reasons: ["You reported warning signs that may require emergency care."],
      redFlagsFound: Array.from(redFlags), isEmergency: true,
    };
  }

  for (const flag of EMERGENCY_RED_FLAGS) {
    if (redFlags.has(flag)) {
      return {
        riskLevel: "Emergency", recommendedCare: "Emergency care now", score: 99,
        reasons: [`Red flag detected: ${flag}. This may require emergency evaluation.`],
        redFlagsFound: Array.from(redFlags), isEmergency: true,
      };
    }
  }

  if (symptoms.includes("fever") && (redFlags.has("stiffNeck") || symptoms.includes("stiffneck"))) {
    return {
      riskLevel: "Emergency", recommendedCare: "Emergency care now", score: 98,
      reasons: ["Fever with a stiff neck can be an emergency warning sign."],
      redFlagsFound: Array.from(redFlags), isEmergency: true,
    };
  }

  const hasAbdominal = symptoms.some((s) => ["abdominalpain", "stomachpain", "lowerabdominalpain"].includes(s));
  const hasBleeding = redFlags.has("bloodInStool") || redFlags.has("blackStool") || redFlags.has("bloodInVomit");
  const hasSevereAbdominal = redFlags.has("severeAbdominalPain");

  if (hasAbdominal && hasSevereAbdominal && hasBleeding) {
    return {
      riskLevel: "Emergency", recommendedCare: "Emergency care now", score: 98,
      reasons: ["Severe abdominal pain with bleeding signs may require emergency evaluation."],
      redFlagsFound: Array.from(redFlags), isEmergency: true,
    };
  }

  const hb = input.healthBackground || {};
  const pregnant = hb.pregnantOrPossiblyPregnant === true || hb.pregnantOrPossiblyPregnant === "yes";

  if (pregnant && (hasAbdominal || symptoms.includes("vaginalbleeding"))) {
    return {
      riskLevel: "High", recommendedCare: "Urgent Care today", score: 8,
      reasons: ["Pregnancy with abdominal pain or bleeding should be reviewed promptly."],
      redFlagsFound: Array.from(redFlags), isEmergency: false,
    };
  }
  if (symptoms.includes("fever") && redFlags.has("rashWithFever")) {
    return {
      riskLevel: "High", recommendedCare: "Urgent Care today", score: 8,
      reasons: ["Fever with rash may need same-day medical review."],
      redFlagsFound: Array.from(redFlags), isEmergency: false,
    };
  }
  if ((redFlags.has("persistentVomiting") || symptoms.includes("persistentvomiting")) &&
      (redFlags.has("severeDehydration") || symptoms.includes("severedehydration"))) {
    return {
      riskLevel: "High", recommendedCare: "Urgent Care today", score: 8,
      reasons: ["Persistent vomiting with dehydration can require same-day care."],
      redFlagsFound: Array.from(redFlags), isEmergency: false,
    };
  }
  if (redFlags.has("notUrinating") || functionImpact.includes("notUrinatingOrVeryLittle")) {
    return {
      riskLevel: "High", recommendedCare: "Urgent Care today", score: 8,
      reasons: ["Very little or no urination can be a sign of dehydration or another urgent problem."],
      redFlagsFound: Array.from(redFlags), isEmergency: false,
    };
  }
  if (hasBreathing && input.severity === "severe") {
    return {
      riskLevel: "High", recommendedCare: "Urgent Care today", score: 8,
      reasons: ["Severe breathing symptoms should be assessed promptly."],
      redFlagsFound: Array.from(redFlags), isEmergency: false,
    };
  }

  let score = 0;
  score += DURATION_SCORES[input.duration] || 0;
  if (score > 0) reasons.push("Your symptoms have lasted longer than a short, self-limited episode.");
  const trendScore = TREND_SCORES[input.trend] || 0;
  score += trendScore;
  if (trendScore > 0) reasons.push("Your symptoms are not clearly improving or have worsened.");
  const sevScore = SEVERITY_SCORES[input.severity] || 0;
  score += sevScore;
  if (sevScore > 0) reasons.push("You reported moderate or severe symptoms.");

  const painScore = Number(input.painScore) || 0;
  const painContrib = painScore >= 7 ? 3 : painScore >= 4 ? 1 : 0;
  score += painContrib;
  if (painContrib > 0) reasons.push("Your pain score increases the need for clinical review.");

  for (const [key, amount] of Object.entries(IMPACT_SCORES)) {
    if (functionImpact.includes(key)) {
      score += amount;
      reasons.push("Your symptoms are affecting important daily function.");
      break;
    }
  }

  for (const [key, amount] of Object.entries(BACKGROUND_SCORES)) {
    const val = (hb as Record<string, unknown>)[key];
    if (val === true || val === "yes") {
      score += amount;
      reasons.push("Your health background may make follow-up more important.");
      break;
    }
  }

  if (symptoms.includes("fever") && (symptoms.includes("cough") || symptoms.includes("sorethroat"))) score += 1;
  if (symptoms.includes("fever") && input.duration === "moreThanSevenDays") score += 2;
  if (hasBreathing) score += 2;
  if (hasChestPain) score += 3;

  let riskLevel: TriageRiskLevel;
  let recommendedCare: TriageRecommendedCare;

  if (score >= 6) {
    riskLevel = "High"; recommendedCare = "Urgent Care today";
  } else if (score >= 3) {
    riskLevel = "Moderate";
    recommendedCare = (input.duration === "moreThanSevenDays" || input.trend === "gettingWorse")
      ? "Primary Care within 24–72 hours" : "Telehealth may be appropriate";
  } else {
    riskLevel = "Low"; recommendedCare = "Self-care and monitoring";
    reasons.unshift("Your symptoms have not been reported as worsening rapidly.");
    reasons.unshift("You reported mild symptoms without emergency warning signs.");
  }

  return {
    riskLevel, recommendedCare, score,
    reasons: reasons.slice(0, 5),
    redFlagsFound: Array.from(redFlags),
    isEmergency: false,
  };
}

export function escalationAdvice(rl: TriageRiskLevel): string[] {
  switch (rl) {
    case "Crisis": return ["If you may hurt yourself or someone else, seek immediate help now.", "Contact local emergency services or a crisis hotline in your country."];
    case "Emergency": return ["Seek emergency medical help now.", "Do not delay care if symptoms are severe or rapidly worsening."];
    case "High": return ["Consider urgent care today, especially if symptoms are worsening or you have higher-risk health background."];
    case "Moderate": return ["Consider contacting a clinician if symptoms persist, worsen, or interfere with daily activities."];
    default: return ["Seek care if symptoms worsen, last longer than expected, or new warning signs appear."];
  }
}
