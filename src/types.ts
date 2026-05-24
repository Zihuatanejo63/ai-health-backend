/**
 * Shared types for the backend.
 */

export type Severity = "mild" | "moderate" | "severe";
export type DurationUnit = "hours" | "days" | "weeks" | "months";
export type RiskLevel = "low" | "medium" | "high";
export type CareLevel =
  | "Emergency"
  | "Urgent Care"
  | "Primary Care"
  | "Telehealth"
  | "Pharmacy/Self-care"
  | "Monitor at home";

export type TriageRiskLevel = "Low" | "Moderate" | "High" | "Emergency" | "Crisis";
export type TriageRecommendedCare =
  | "Self-care and monitoring"
  | "Telehealth may be appropriate"
  | "Primary Care within 24–72 hours"
  | "Urgent Care today"
  | "Emergency care now"
  | "Crisis support now";

export interface AnalyzeSymptomsRequest {
  symptoms: string;
  severity: Severity;
  durationValue: number;
  durationUnit: DurationUnit;
  outputLanguage?: string;
  imageBase64?: string;
  imageMimeType?: string;
}

export interface TriageApiRequest {
  symptoms: string[];
  primarySymptom: string;
  duration: string;
  trend: string;
  severity: string;
  painScore: number | string;
  redFlags: string[];
  functionImpact: string[];
  healthBackground: Record<string, string | boolean | string[]>;
  details?: Record<string, string>;
  primaryConcern?: string;
  outputLanguage?: string;
}

export interface TriageApiResponse {
  riskLevel: TriageRiskLevel;
  recommendedCare: TriageRecommendedCare;
  score: number;
  reasons: string[];
  redFlagsFound: string[];
  possibleCauses: string[];
  whatToMonitor: string[];
  escalationAdvice: string[];
  doctorReadySummary: string;
  plainLanguageExplanation: string;
  questionsToAskClinician: string[];
  coverageQuestions: string[];
  disclaimer: string;
  referenceId: string;
  aiGenerated: boolean;
}

export interface CreateCheckoutRequest {
  plan: "plus_monthly";
}

export interface UserResponse {
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
  } | null;
  entitlement: {
    planId: string;
    status: string;
    currentPeriodEnd?: string;
  };
}

export interface RequestLinkRequest {
  email: string;
}

export interface RequestLinkResponse {
  ok: true;
  message: string;
}
