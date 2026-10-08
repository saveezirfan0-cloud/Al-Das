import "server-only";

import { Resend } from "resend";

import { serverEnv } from "@/lib/env";

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

export type EmailResult =
  { delivered: true; id: string | null } | { delivered: false; reason: string };

/**
 * Sends through Resend when RESEND_API_KEY is set. Otherwise logs a redacted
 * line and reports delivered=false so callers can show the link in the UI.
 */
export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const env = serverEnv();
  if (!env.RESEND_API_KEY) {
    console.info("[email] RESEND_API_KEY not set; not sending", {
      to: redactEmail(message.to),
      subject: message.subject,
    });
    return { delivered: false, reason: "email_not_configured" };
  }
  const resend = new Resend(env.RESEND_API_KEY);
  const { data, error } = await resend.emails.send({
    from: env.RESEND_FROM,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
  if (error) {
    console.error("[email] send failed", { to: redactEmail(message.to), name: error.name });
    return { delivered: false, reason: error.message };
  }
  return { delivered: true, id: data?.id ?? null };
}

export function redactEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}
