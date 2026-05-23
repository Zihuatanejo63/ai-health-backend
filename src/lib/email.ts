/**
 * Email sending via Resend for magic link authentication.
 * Falls back to console log in development when EMAIL_API_KEY is not configured.
 *
 * Required env vars:
 *   EMAIL_API_KEY  — Resend API key
 *   EMAIL_FROM     — sender address (e.g. "HealthMatchAI <noreply@healthmatchai.com>")
 *   SUPPORT_EMAIL  — support contact shown in email footer
 */

export interface SendMagicLinkInput {
  email: string;
  token: string;
  appUrl: string;
}

interface Env {
  EMAIL_API_KEY?: string;
  EMAIL_FROM?: string;
  SUPPORT_EMAIL?: string;
}

const MAGIC_LINK_TTL_MINUTES = 15;

function magicLinkEmailHtml(verifyUrl: string, supportEmail: string): string {
  const expiresIn = `${MAGIC_LINK_TTL_MINUTES} minutes`;
  return [
    '<!DOCTYPE html><html><body style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px">',
    '<h2 style="color:#1a1a2e">Sign in to HealthMatchAI</h2>',
    '<p>Click the button below to sign in. This link expires in ' + expiresIn + '.</p>',
    '<p style="margin:24px 0">',
    '<a href="' + verifyUrl + '" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">Sign in to HealthMatchAI</a>',
    '</p>',
    '<p style="color:#6b7280;font-size:14px">If you did not request this link, you can safely ignore this email.</p>',
    '<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">',
    '<p style="color:#9ca3af;font-size:12px">HealthMatchAI provides educational symptom guidance only. It does not diagnose, prescribe, or replace professional medical care.</p>',
    '<p style="color:#9ca3af;font-size:12px">Contact: ' + supportEmail + '</p>',
    '</body></html>',
  ].join("\n");
}

function magicLinkEmailText(verifyUrl: string, supportEmail: string): string {
  return [
    "Sign in to HealthMatchAI",
    "",
    "Click this link to sign in (expires in " + MAGIC_LINK_TTL_MINUTES + " minutes):",
    verifyUrl,
    "",
    "If you did not request this link, you can safely ignore this email.",
    "",
    "HealthMatchAI provides educational symptom guidance only.",
    "It does not diagnose, prescribe, or replace professional medical care.",
    "Contact: " + supportEmail,
  ].join("\n");
}

export async function sendMagicLink(input: SendMagicLinkInput, env?: Env): Promise<void> {
  const verifyUrl = `${input.appUrl}/api/auth/verify?token=${encodeURIComponent(input.token)}`;
  const supportEmail = env?.SUPPORT_EMAIL || "support@healthmatchai.com";

  if (!env?.EMAIL_API_KEY) {
    // Development mode: log token hash only, never full token
    const tokenPreview = input.token.slice(0, 6) + "..." + input.token.slice(-4);
    console.log(`[DEV MAGIC LINK] To: ${input.email} | Token preview: ${tokenPreview} | Expires: ${MAGIC_LINK_TTL_MINUTES}min`);
    return;
  }

  const from = env.EMAIL_FROM || "HealthMatchAI <noreply@healthmatchai.com>";

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.EMAIL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: input.email,
      subject: "Sign in to HealthMatchAI",
      html: magicLinkEmailHtml(verifyUrl, supportEmail),
      text: magicLinkEmailText(verifyUrl, supportEmail),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Email send failed (${response.status}): ${body.slice(0, 200)}`);
  }
}
