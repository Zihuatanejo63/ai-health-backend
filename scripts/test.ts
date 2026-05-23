/**
 * Backend automated tests.
 * Run: npx tsx scripts/test.ts
 */

import { evalTriage, escalationAdvice, type TriageResult } from "../src/lib/triage-engine";
import { containsForbiddenContent } from "../src/lib/gemini";
import { hashValue } from "../src/routes/auth";
import { verifyCreemSignature } from "../src/routes/payments";
import type { TriageApiRequest } from "../src/types";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  assert(actual === expected, `${message} (expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)})`);
}

function assertDeep(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  assert(a === b, `${message} (expected: ${b}, got: ${a})`);
}

function triage(input: Partial<TriageApiRequest>): TriageResult {
  return evalTriage({
    symptoms: [],
    primarySymptom: "",
    duration: "lessThan24h",
    trend: "gettingBetter",
    severity: "mild",
    painScore: 0,
    redFlags: [],
    functionImpact: [],
    healthBackground: {},
    ...input,
  });
}

async function main() {
  // ============================================================
  // 1. Triage Rule Engine
  // ============================================================
  console.log("\n--- Triage Rule Engine ---");

  // Crisis detection
  {
    const result = triage({ symptoms: ["suicidal-thoughts"] });
    assertEq(result.riskLevel, "Crisis", "Crisis: risk level for suicidal thoughts");
    assertEq(result.recommendedCare, "Crisis support now", "Crisis: recommended care");
    assert(result.isEmergency, "Crisis: isEmergency is true");
  }

  {
    const result = triage({ symptoms: ["headache"], redFlags: ["suicidalThoughts"] });
    assertEq(result.riskLevel, "Crisis", "Crisis: red flag suicidalThoughts");
  }

  // Emergency detection — chest pain + breathing
  {
    const result = triage({
      symptoms: ["chest-pain", "shortness-of-breath"],
      redFlags: ["chestPainOrPressure", "troubleBreathing"],
    });
    assertEq(result.riskLevel, "Emergency", "Emergency: chest pain + breathing");
    assertEq(result.recommendedCare, "Emergency care now", "Emergency: recommended care");
    assert(result.isEmergency, "Emergency: isEmergency is true");
  }

  // Emergency detection — neurological
  {
    const result = triage({ symptoms: ["confusion", "headache"] });
    assertEq(result.riskLevel, "Emergency", "Emergency: confusion symptom");
  }

  {
    const result = triage({ symptoms: ["seizure"] });
    assertEq(result.riskLevel, "Emergency", "Emergency: seizure symptom");
  }

  // Emergency detection — emergency red flags
  {
    const result = triage({ symptoms: ["headache"], redFlags: ["severeBleeding"] });
    assertEq(result.riskLevel, "Emergency", "Emergency: severeBleeding red flag");
  }

  {
    const result = triage({ symptoms: ["headache"], redFlags: ["hardToWake"] });
    assertEq(result.riskLevel, "Emergency", "Emergency: hardToWake red flag");
  }

  // Emergency — fever + stiff neck
  {
    const result = triage({ symptoms: ["fever", "headache"], redFlags: ["stiffNeck"] });
    assertEq(result.riskLevel, "Emergency", "Emergency: fever + stiff neck");
  }

  // Emergency — abdominal + bleeding
  {
    const result = triage({
      symptoms: ["abdominal-pain"],
      redFlags: ["severeAbdominalPain", "blackStool"],
      severity: "severe",
    });
    assertEq(result.riskLevel, "Emergency", "Emergency: abdominal pain + black stool");
  }

  // High — pregnant + abdominal pain
  {
    const result = triage({
      symptoms: ["abdominal-pain"],
      healthBackground: { pregnantOrPossiblyPregnant: true },
    });
    assertEq(result.riskLevel, "High", "High: pregnant + abdominal pain");
  }

  // High — severe breathing
  {
    const result = triage({ symptoms: ["shortness-of-breath"], severity: "severe" });
    assertEq(result.riskLevel, "High", "High: severe breathing");
  }

  // High — not urinating
  {
    const result = triage({ symptoms: ["fatigue"], redFlags: ["notUrinating"] });
    assertEq(result.riskLevel, "High", "High: not urinating red flag");
  }

  // Moderate
  {
    const result = triage({
      symptoms: ["fever", "cough"],
      duration: "fourToSevenDays",
      trend: "gettingWorse",
      severity: "moderate",
    });
    assertEq(result.riskLevel, "Moderate", "Moderate: fever + cough worsening");
  }

  // Low
  {
    const result = triage({
      symptoms: ["runny-nose"],
      severity: "mild",
      duration: "oneToThreeDays",
    });
    assertEq(result.riskLevel, "Low", "Low: mild runny nose");
    assertEq(result.recommendedCare, "Self-care and monitoring", "Low: self-care recommendation");
  }

  // Emergency is never downgraded
  {
    const emergencyCases: Partial<TriageApiRequest>[] = [
      { symptoms: ["suicidal-thoughts"] },
      { symptoms: ["chest-pain", "shortness-of-breath"], redFlags: ["chestPainOrPressure", "troubleBreathing"] },
      { symptoms: ["confusion"] },
      { symptoms: ["headache"], redFlags: ["severeBleeding"] },
    ];
    for (const c of emergencyCases) {
      const result = triage(c);
      assert(result.isEmergency, `Never downgrade: ${c.symptoms?.join(", ")} stays emergency (score=${result.score})`);
    }
  }

  // Pain score escalation
  {
    const lowPain = triage({ symptoms: ["headache"], painScore: 2, severity: "mild" });
    const highPain = triage({ symptoms: ["headache"], painScore: 8, severity: "mild" });
    assert(highPain.score > lowPain.score, "Pain score: high pain (8) escalates score above low pain (2)");
  }

  // Health background escalation
  {
    const noBg = triage({ symptoms: ["fever"], severity: "mild" });
    const immunoBg = triage({ symptoms: ["fever"], severity: "mild", healthBackground: { immunocompromised: true } });
    assert(immunoBg.score > noBg.score, "Background: immunocompromised escalates score");
  }

  // ============================================================
  // 2. Escalation Advice
  // ============================================================
  console.log("\n--- Escalation Advice ---");

  assertDeep(escalationAdvice("Crisis").length, 2, "Crisis: 2 advice items");
  assertDeep(escalationAdvice("Emergency").length, 2, "Emergency: 2 advice items");
  assertDeep(escalationAdvice("High").length, 1, "High: 1 advice item");
  assertDeep(escalationAdvice("Moderate").length, 1, "Moderate: 1 advice item");
  assertDeep(escalationAdvice("Low").length, 1, "Low: 1 advice item");

  // ============================================================
  // 3. Token Hashing
  // ============================================================
  console.log("\n--- Token Hashing ---");

  {
    const hash1 = await hashValue("test-token-abc123");
    const hash2 = await hashValue("test-token-abc123");
    const hash3 = await hashValue("different-token");
    assertEq(hash1, hash2, "Token hash: same input produces same hash");
    assert(hash1 !== hash3, "Token hash: different input produces different hash");
    assert(hash1.length === 64, "Token hash: SHA-256 produces 64 hex chars");
  }

  // ============================================================
  // 4. Webhook Signature Verification
  // ============================================================
  console.log("\n--- Webhook Signature ---");

  {
    const secret = "test-webhook-secret";
    const body = JSON.stringify({ eventType: "checkout.completed", id: "evt_123" });

    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const validSig = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");

    const valid = await verifyCreemSignature(body, validSig, secret);
    assert(valid, "Webhook: valid signature passes verification");

    const invalid = await verifyCreemSignature(body, "deadbeef", secret);
    assert(!invalid, "Webhook: invalid signature fails verification");

    const wrongBody = await verifyCreemSignature("wrong body", validSig, secret);
    assert(!wrongBody, "Webhook: wrong body fails verification");
  }

  // ============================================================
  // 5. Gemini Safety Filter — Forbidden Content
  // ============================================================
  console.log("\n--- Gemini Safety Filter ---");

  {
    assert(containsForbiddenContent("You are diagnosed with pneumonia.") !== null,
      "Safety: detects 'diagnosed with'");

    assert(containsForbiddenContent("This certainly is a viral infection.") !== null,
      "Safety: detects 'certainly is'");

    assert(containsForbiddenContent("There is no need to see a doctor for this.") !== null,
      "Safety: detects 'no need to see'");

    assert(containsForbiddenContent("You should take 500mg of ibuprofen.") !== null,
      "Safety: detects dosage language");

    assert(containsForbiddenContent("I recommend the Blue Cross insurance plan for you.") !== null,
      "Safety: detects insurance recommendation");

    assert(containsForbiddenContent("Possible: viral infection. Discuss with your clinician.") === null,
      "Safety: safe content passes (Possible: prefix)");

    assert(containsForbiddenContent("Your symptoms may be caused by several conditions. A doctor can evaluate based on exam and history.") === null,
      "Safety: safe content passes (cautious language)");

    assert(containsForbiddenContent("What is my copay for this type of visit? Is this provider in-network?") === null,
      "Safety: safe content passes (coverage questions)");
  }

  // ============================================================
  // Summary
  // ============================================================
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
  console.log(`${"=".repeat(50)}`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
