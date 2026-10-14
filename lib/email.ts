import "server-only";

import { Resend } from "resend";

import { serverEnv } from "@/lib/env";

/**
 * Transactional e-mail through Resend. Attachments (Phase G) follow Resend's shape: a file name, the bytes and a content
 * type. Only the kinds Pulse produces itself are allowed (PDF, Excel, CSV), with a count and size cap checked before
 * anything is sent. Logs carry a masked address, the subject and attachment counts only: never a body or a file name.
 */

export type EmailAttachment = {
  filename: string;
  content: Uint8Array;
  contentType: string;
};

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: readonly EmailAttachment[];
  /** Resend keeps a key for 24 hours: a retry with the same key is not sent twice. */
  idempotencyKey?: string;
};

export type EmailResult =
  { delivered: true; id: string | null } | { delivered: false; reason: string };

/** What a transport receives: the message as Resend takes it. Tests pass a fake; nothing in a test may reach Resend. */
export type EmailPayload = {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType: string }>;
};
export type EmailTransport = (
  payload: EmailPayload,
  options: { idempotencyKey?: string },
) => Promise<{ id: string | null } | { error: { name: string; message: string } }>;

export const ATTACHMENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
] as const;
export const MAX_ATTACHMENTS = 5;
/** Resend allows 40 MB per message after encoding; Pulse's own documents are far smaller, so the cap is low. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Why these attachments cannot be sent, or null. Pure. */
export function attachmentProblem(atts: readonly EmailAttachment[] | undefined): string | null {
  if (!atts || atts.length === 0) return null;
  if (atts.length > MAX_ATTACHMENTS) return "too_many_attachments";
  let total = 0;
  for (const a of atts) {
    if (!SAFE_NAME.test(a.filename) || a.filename.includes("..")) return "bad_attachment_name";
    if (!(ATTACHMENT_TYPES as readonly string[]).includes(a.contentType))
      return "bad_attachment_type";
    if (a.content.byteLength === 0) return "empty_attachment";
    total += a.content.byteLength;
  }
  return total > MAX_ATTACHMENT_BYTES ? "attachments_too_large" : null;
}

function resendTransport(apiKey: string): EmailTransport {
  const resend = new Resend(apiKey);
  return async (payload, options) => {
    const { data, error } = await resend.emails.send(payload, options);
    if (error) return { error: { name: error.name, message: error.message } };
    return { id: data?.id ?? null };
  };
}

/**
 * Sends through Resend when RESEND_API_KEY is set (or through `opts.transport`). Otherwise logs a redacted line and
 * reports delivered=false (`email_not_configured`) so callers can show the link in the UI instead.
 */
export async function sendEmail(
  message: EmailMessage,
  opts: { transport?: EmailTransport; from?: string } = {},
): Promise<EmailResult> {
  const problem = attachmentProblem(message.attachments);
  if (problem) return { delivered: false, reason: problem };
  const env = opts.transport ? null : serverEnv();
  const attachments = message.attachments?.length ?? 0;
  if (!opts.transport && !env?.RESEND_API_KEY) {
    console.info("[email] RESEND_API_KEY not set; not sending", {
      to: redactEmail(message.to),
      subject: message.subject,
      attachments,
    });
    return { delivered: false, reason: "email_not_configured" };
  }
  const transport = opts.transport ?? resendTransport(env!.RESEND_API_KEY!);
  const from = opts.from ?? env?.RESEND_FROM ?? "Pulse <no-reply@example.com>";
  const res = await transport(
    {
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      ...(attachments
        ? {
            attachments: message.attachments!.map((a) => ({
              filename: a.filename,
              content: Buffer.from(a.content),
              contentType: a.contentType,
            })),
          }
        : {}),
    },
    message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : {},
  );
  if ("error" in res) {
    console.error("[email] send failed", {
      to: redactEmail(message.to),
      name: res.error.name,
      attachments,
    });
    return { delivered: false, reason: res.error.message };
  }
  return { delivered: true, id: res.id };
}

export function redactEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}
