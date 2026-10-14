import { createHash } from "node:crypto";

import { z } from "zod";

import { CUSTOMER_KINDS, type CustomerKind } from "@/lib/accounting/sales";
import type { EmailAttachment, EmailMessage, EmailResult } from "@/lib/email";
import { monthLabel } from "@/lib/finance/close-pack";

/**
 * E-mailing finance documents (Phase G), the pure part: what can be sent, to whom, with which words, and the job that
 * carries the request through the `notifications` queue.
 *
 * The queue message holds ids, dates and a SHA-256 of the confirmed address only: never the address itself, a name, an
 * amount or the document. The job re-reads the recipient and renders the document when it runs, and refuses when the
 * address no longer matches the one the person confirmed. Customers are businesses (acc_customers: insurers,
 * corporates, tenants, others), never patients; the close pack goes only to the people who signed it.
 */

export const DOCUMENT_KINDS = [
  "customer_statement",
  "balance_confirmation",
  "close_pack",
  "sales_invoice",
  "daily_flash",
  "monthly_summary",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const date = z
  .string()
  .regex(DATE)
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "Enter a valid date.");
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

export const documentSpec = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("customer_statement"),
      customer_id: z.string().uuid(),
      from: date,
      to: date,
    })
    .refine((d) => d.from <= d.to, "The start date is after the end date."),
  z.object({
    kind: z.literal("balance_confirmation"),
    customer_id: z.string().uuid(),
    as_of: date,
  }),
  z.object({ kind: z.literal("close_pack"), month, recipient_user_id: z.string().uuid() }),
  // a business customer's issued invoice or credit note, as a copy (never a patient's)
  z.object({
    kind: z.literal("sales_invoice"),
    customer_id: z.string().uuid(),
    invoice_id: z.string().uuid(),
  }),
  // the finance reports, to a member who holds the report's own key (re-checked when the job runs); run_id is set for a
  // scheduled send (fin_report_schedule_runs) and null when a person e-mailed it to themselves from the Reports hub
  z.object({
    kind: z.literal("daily_flash"),
    day: date,
    recipient_user_id: z.string().uuid(),
    run_id: z.string().uuid().nullable().default(null),
  }),
  z
    .object({
      kind: z.literal("monthly_summary"),
      from: month,
      to: month,
      branch: z
        .string()
        .regex(/^[A-Z0-9]{1,4}$/)
        .nullable()
        .default(null),
      recipient_user_id: z.string().uuid(),
      run_id: z.string().uuid().nullable().default(null),
    })
    .refine((d) => d.from <= d.to, "The first month is after the last."),
]);
export type DocumentSpec = z.infer<typeof documentSpec>;

export const DOCUMENT_EMAIL_JOB = "finance_document_email" as const;

export const documentEmailJob = z.object({
  type: z.literal(DOCUMENT_EMAIL_JOB),
  request_id: z.string().uuid(),
  org_id: z.string().uuid(),
  requested_by: z.string().uuid(),
  recipient_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  document: documentSpec,
});
export type DocumentEmailJob = z.infer<typeof documentEmailJob>;

/** The fingerprint of an address as the person confirmed it (case and surrounding spaces ignored). */
export function recipientHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

/** A shape check for an address read from the database (the forms validate properly on the way in). */
export function plausibleEmail(v: string | null | undefined): v is string {
  return !!v && v.length <= 200 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim());
}

/** Shows enough of an address to recognise it on the confirmation, as the e-mail log does. */
export function maskAddress(email: string): string {
  const [local, domain] = email.trim().split("@");
  if (!domain) return "***";
  return `${local.slice(0, 2)}***@${domain}`;
}

export const BUSINESS_CUSTOMER_KINDS: readonly CustomerKind[] = CUSTOMER_KINDS;

/** Why this customer cannot be e-mailed a statement or a confirmation, or null. */
export function customerEmailProblem(c: {
  kind: string;
  email: string | null;
  active: boolean;
}): string | null {
  if (!(BUSINESS_CUSTOMER_KINDS as readonly string[]).includes(c.kind))
    return "Only business customers can be e-mailed.";
  if (!c.active) return "This customer is inactive.";
  if (!plausibleEmail(c.email))
    return "This customer has no e-mail address. Add one under Accounting, Customers.";
  return null;
}

export function documentFilename(
  d: DocumentSpec,
  opts: { draft?: boolean; number?: string | null } = {},
): string {
  switch (d.kind) {
    case "customer_statement":
      return `statement-${d.from}-${d.to}.pdf`;
    case "balance_confirmation":
      return `balance-confirmation-${d.as_of}.pdf`;
    case "close_pack":
      return `month-end-close-${d.month}${opts.draft ? "-draft" : ""}.pdf`;
    case "sales_invoice":
      return `${opts.number ? opts.number.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 60) : "invoice"}-copy.pdf`;
    case "daily_flash":
      return `flash-report-${d.day}.xlsx`;
    case "monthly_summary":
      return d.from === d.to
        ? `finance-summary-${d.from}.xlsx`
        : `finance-summary-${d.from}-${d.to}.xlsx`;
  }
}

/** The member a report or close pack goes to (null for a business customer's document). */
export function memberRecipientOf(d: DocumentSpec): string | null {
  return d.kind === "close_pack" || d.kind === "daily_flash" || d.kind === "monthly_summary"
    ? d.recipient_user_id
    : null;
}

export const DOCUMENT_LABELS: Record<DocumentKind, string> = {
  customer_statement: "statement of account",
  balance_confirmation: "balance confirmation",
  close_pack: "month-end close pack",
  sales_invoice: "invoice copy",
  daily_flash: "daily flash report",
  monthly_summary: "monthly finance summary",
};

/**
 * The subject and text of the e-mail. Business wording only: the sender's name, the period and, for a customer, the
 * customer's own name and closing balance. The close pack mail names no figure at all (the pack is the attachment).
 */
export function documentEmailText(
  d: DocumentSpec,
  ctx: {
    orgName: string;
    recipientName: string | null;
    closing?: number | null;
    draft?: boolean;
    /** Final (the months are locked) or provisional, for the reports. */
    provisional?: boolean;
    /** The invoice or credit note number and date, for a sales document. */
    reference?: { number: string; date: string; creditNote: boolean } | null;
  },
): { subject: string; text: string } {
  const org = ctx.orgName.trim() || "Pulse";
  const hello = ctx.recipientName ? `Dear ${ctx.recipientName},` : "Hello,";
  const amount = (n: number) =>
    n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  switch (d.kind) {
    case "customer_statement": {
      const closing =
        typeof ctx.closing === "number"
          ? ctx.closing >= 0
            ? ` The balance owed to ${org} on ${d.to} was AED ${amount(ctx.closing)}.`
            : ` On ${d.to} ${org} held AED ${amount(-ctx.closing)} for you.`
          : "";
      return {
        subject: `${org}: statement of account, ${d.from} to ${d.to}`,
        text: [
          hello,
          "",
          `Please find attached your statement of account with ${org} for ${d.from} to ${d.to}.${closing}`,
          "",
          "If anything does not agree with your records, please reply to this e-mail.",
          "",
          `${org} finance team`,
        ].join("\n"),
      };
    }
    case "balance_confirmation":
      return {
        subject: `${org}: balance confirmation as at ${d.as_of}`,
        text: [
          hello,
          "",
          `For our auditors, please confirm the balance shown in the attached letter as at ${d.as_of}, or tell us of any difference.`,
          "",
          `${org} finance team`,
        ].join("\n"),
      };
    case "close_pack": {
      const label = monthLabel(`${d.month}-01`);
      return {
        subject: `${org}: month-end close pack, ${label}${ctx.draft ? " (draft)" : ""}`,
        text: [
          hello,
          "",
          `The month-end close pack for ${label} is attached${ctx.draft ? " as it stands now (the month is not locked yet)" : ""}.`,
          "It is sent to the people who signed the close. Please do not forward it.",
          "",
          "Sent from Pulse",
        ].join("\n"),
      };
    }
    case "sales_invoice": {
      const what = ctx.reference?.creditNote ? "credit note" : "invoice";
      const ref = ctx.reference ? ` ${ctx.reference.number} dated ${ctx.reference.date}` : "";
      return {
        subject: `${org}: copy of ${what}${ctx.reference ? ` ${ctx.reference.number}` : ""}`,
        text: [
          hello,
          "",
          `Please find attached a copy of ${what}${ref} from ${org}, for your records.`,
          "If anything does not agree with your records, please reply to this e-mail.",
          "",
          `${org} finance team`,
        ].join("\n"),
      };
    }
    // The reports: a fixed sentence with the period only. The figures are in the attachment, never in the e-mail.
    case "daily_flash":
      return {
        subject: `${org}: daily flash report for ${d.day}${ctx.provisional === false ? "" : " (provisional)"}`,
        text: ["Hello,", "", `The daily flash report for ${d.day} is attached.`, REPORT_FOOTER].join(
          "\n",
        ),
      };
    case "monthly_summary": {
      const label =
        d.from === d.to
          ? monthLabel(`${d.from}-01`)
          : `${monthLabel(`${d.from}-01`)} to ${monthLabel(`${d.to}-01`)}`;
      return {
        subject: `${org}: monthly finance summary, ${label}${ctx.provisional === false ? "" : " (provisional)"}`,
        text: [
          "Hello,",
          "",
          `The monthly finance summary for ${label} is attached.`,
          REPORT_FOOTER,
        ].join("\n"),
      };
    }
  }
}

/** The rest of every report e-mail: why it came, and that it stays inside the clinic. No figures, no names. */
const REPORT_FOOTER = [
  "You receive it because you are on this report's list in Pulse and hold the permission to see it.",
  "Please do not forward it.",
  "",
  "Sent from Pulse",
].join("\n");

export type DocumentEmailOutcome =
  | "sent"
  | "not_configured"
  | "recipient_missing"
  | "recipient_changed"
  | "recipient_not_allowed"
  | "document_missing";

/** The steps the job takes, as ports so the order and the refusals are tested without a database or Resend. */
export type DocumentEmailPorts = {
  orgName(): Promise<string>;
  /** null: gone or no address; "not_allowed": a member who no longer holds the report's permission. */
  recipient(): Promise<{ email: string; name: string | null } | null | "not_allowed">;
  render(): Promise<{
    attachment: EmailAttachment;
    closing?: number | null;
    draft?: boolean;
    provisional?: boolean;
    reference?: { number: string; date: string; creditNote: boolean } | null;
  } | null>;
  send(message: EmailMessage): Promise<EmailResult>;
};

/**
 * Runs one request: re-read the recipient (refuse when it is gone or no longer the address that was confirmed), render
 * the document from stored data, send it with the request id as the idempotency key. A send that failed for a reason other
 * than "not configured" throws, so the queue retries it (the key keeps Resend from sending it twice).
 */
export async function runDocumentEmail(
  job: DocumentEmailJob,
  ports: DocumentEmailPorts,
): Promise<DocumentEmailOutcome> {
  const who = await ports.recipient();
  if (who === "not_allowed") return "recipient_not_allowed";
  if (!who || !plausibleEmail(who.email)) return "recipient_missing";
  if (recipientHash(who.email) !== job.recipient_sha256) return "recipient_changed";
  const doc = await ports.render();
  if (!doc) return "document_missing";
  const words = documentEmailText(job.document, {
    orgName: await ports.orgName(),
    recipientName: who.name,
    closing: doc.closing ?? null,
    draft: doc.draft ?? false,
    provisional: doc.provisional,
    reference: doc.reference ?? null,
  });
  const res = await ports.send({
    to: who.email.trim(),
    subject: words.subject,
    text: words.text,
    attachments: [doc.attachment],
    idempotencyKey: `pulse-findoc-${job.request_id}`,
  });
  if (res.delivered) return "sent";
  if (res.reason === "email_not_configured") return "not_configured";
  throw new Error(`finance document e-mail failed: ${res.reason.slice(0, 80)}`);
}

/** What the person who asked is told in Pulse when the job gives up (generic: no address, no name). */
export const OUTCOME_NOTICE: Partial<Record<DocumentEmailOutcome, string>> = {
  not_configured: "E-mail is not set up yet, so the document was not sent. Download it instead.",
  recipient_missing: "The document was not sent: the recipient no longer has an e-mail address.",
  recipient_changed:
    "The document was not sent: the recipient's e-mail address changed after you confirmed it. Send it again.",
  recipient_not_allowed:
    "A report was not sent: the person no longer holds the permission to see it, or finance is closed for them now.",
  document_missing: "The document was not sent: it could not be found any more.",
};
