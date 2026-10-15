/**
 * Phase G: e-mailing finance documents (pure part and the job's steps over fake ports). The queue message holds ids,
 * dates and the SHA-256 of the confirmed address only; the job refuses a changed address. A fake transport stands in for
 * Resend.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendEmail, type EmailPayload, type EmailTransport } from "@/lib/email";
import {
  customerEmailProblem,
  documentEmailJob,
  documentEmailText,
  documentFilename,
  documentSpec,
  maskAddress,
  memberRecipientOf,
  OUTCOME_NOTICE,
  recipientHash,
  runDocumentEmail,
  type DocumentEmailJob,
  type DocumentEmailPorts,
} from "@/lib/finance/document-email";

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const REQUEST = "44444444-4444-4444-8444-444444444444";
const ADDRESS = "Accounts@Insurer.example.test";

const job = (over: Partial<DocumentEmailJob> = {}): DocumentEmailJob => ({
  type: "finance_document_email",
  request_id: REQUEST,
  org_id: ORG,
  requested_by: USER,
  recipient_sha256: recipientHash(ADDRESS),
  document: {
    kind: "customer_statement",
    customer_id: CUSTOMER,
    from: "2026-07-01",
    to: "2026-09-30",
  },
  ...over,
});

const attachment = {
  filename: "statement-2026-07-01-2026-09-30.pdf",
  content: new Uint8Array([37, 80, 68, 70]),
  contentType: "application/pdf",
};

function ports(over: Partial<DocumentEmailPorts> = {}) {
  const sent: Parameters<DocumentEmailPorts["send"]>[0][] = [];
  const p: DocumentEmailPorts = {
    orgName: async () => "Synthetic Clinic",
    recipient: async () => ({ email: ADDRESS, name: "Synthetic Insurer LLC" }),
    render: async () => ({ attachment, closing: 1250.5 }),
    send: async (m) => {
      sent.push(m);
      return { delivered: true, id: "fake" };
    },
    ...over,
  };
  return { p, sent };
}

describe("document e-mail rules", () => {
  it("fingerprints an address without case or spaces", () => {
    expect(recipientHash(" accounts@insurer.example.test ")).toBe(recipientHash(ADDRESS));
    expect(recipientHash(ADDRESS)).toMatch(/^[0-9a-f]{64}$/);
    expect(maskAddress(ADDRESS)).toBe("Ac***@Insurer.example.test");
  });

  it("e-mails active business customers with an address only", () => {
    const ok = { kind: "insurer", email: ADDRESS, active: true };
    expect(customerEmailProblem(ok)).toBeNull();
    expect(customerEmailProblem({ ...ok, kind: "corporate" })).toBeNull();
    expect(customerEmailProblem({ ...ok, email: null })).toMatch(/no e-mail address/);
    expect(customerEmailProblem({ ...ok, email: "not-an-address" })).toMatch(/no e-mail address/);
    expect(customerEmailProblem({ ...ok, active: false })).toMatch(/inactive/);
    expect(customerEmailProblem({ ...ok, kind: "patient" })).toMatch(/business customers/);
  });

  it("validates what can be sent", () => {
    expect(documentSpec.safeParse(job().document).success).toBe(true);
    expect(
      documentSpec.safeParse({
        kind: "customer_statement",
        customer_id: CUSTOMER,
        from: "2026-10-01",
        to: "2026-09-30",
      }).success,
    ).toBe(false);
    expect(
      documentSpec.safeParse({ kind: "close_pack", month: "2026-13", recipient_user_id: USER })
        .success,
    ).toBe(false);
    expect(documentSpec.safeParse({ kind: "invoice", id: CUSTOMER }).success).toBe(false);
  });

  it("never carries the address (or anything else) in the queue message", () => {
    const parsed = documentEmailJob.parse({ ...job(), to: ADDRESS, body: "hello", amount: 12 });
    expect(JSON.stringify(parsed)).not.toMatch(/insurer\.example|hello|amount/i);
    expect(Object.keys(parsed).sort()).toEqual(
      ["document", "org_id", "recipient_sha256", "request_id", "requested_by", "type"].sort(),
    );
  });

  it("words each e-mail with the sender, the period and (for a statement) the closing balance only", () => {
    const st = documentEmailText(job().document, {
      orgName: "Synthetic Clinic",
      recipientName: "Synthetic Insurer LLC",
      closing: 1250.5,
    });
    expect(st.subject).toBe("Synthetic Clinic: statement of account, 2026-07-01 to 2026-09-30");
    expect(st.text).toContain("Dear Synthetic Insurer LLC,");
    expect(st.text).toContain("AED 1,250.50");
    const credit = documentEmailText(job().document, {
      orgName: "X",
      recipientName: null,
      closing: -20,
    });
    expect(credit.text).toContain("held AED 20.00 for you");
    const pack = documentEmailText(
      { kind: "close_pack", month: "2026-09", recipient_user_id: USER },
      { orgName: "Synthetic Clinic", recipientName: "Sam", draft: true },
    );
    expect(pack.subject).toBe("Synthetic Clinic: month-end close pack, September 2026 (draft)");
    expect(pack.text).not.toMatch(/AED|\d+\.\d\d/);
    expect(
      documentFilename(
        { kind: "close_pack", month: "2026-09", recipient_user_id: USER },
        { draft: true },
      ),
    ).toBe("month-end-close-2026-09-draft.pdf");
  });
});

describe("Phase G: reports and invoice copies", () => {
  const RUN = "55555555-5555-4555-8555-555555555555";
  const INVOICE = "66666666-6666-4666-8666-666666666666";
  const flash = { kind: "daily_flash" as const, day: "2026-10-13", recipient_user_id: USER, run_id: RUN };
  const summary = {
    kind: "monthly_summary" as const,
    from: "2026-09",
    to: "2026-09",
    branch: null,
    recipient_user_id: USER,
    run_id: null,
  };

  it("validates the new kinds (a run id is optional, the branch is a code)", () => {
    expect(documentSpec.parse({ kind: "daily_flash", day: "2026-10-13", recipient_user_id: USER })).toEqual({
      ...flash,
      run_id: null,
    });
    expect(documentSpec.safeParse({ ...flash, day: "2026-13-01" }).success).toBe(false);
    expect(documentSpec.safeParse({ ...summary, from: "2026-10", to: "2026-09" }).success).toBe(false);
    expect(documentSpec.safeParse({ ...summary, branch: "G; drop" }).success).toBe(false);
    expect(documentSpec.safeParse({ ...summary, branch: "G" }).success).toBe(true);
    expect(
      documentSpec.safeParse({ kind: "sales_invoice", customer_id: CUSTOMER, invoice_id: INVOICE }).success,
    ).toBe(true);
    expect(memberRecipientOf(flash)).toBe(USER);
    expect(
      memberRecipientOf({ kind: "sales_invoice", customer_id: CUSTOMER, invoice_id: INVOICE }),
    ).toBeNull();
  });

  it("words a report e-mail with a fixed sentence and the period only: no figures, no names", () => {
    const f = documentEmailText(flash, { orgName: "Synthetic Clinic", recipientName: "Sam Demo", provisional: true });
    expect(f.subject).toBe("Synthetic Clinic: daily flash report for 2026-10-13 (provisional)");
    expect(f.text.startsWith("Hello,")).toBe(true);
    expect(f.text).not.toContain("Sam");
    // the only digits are the date
    expect(f.text.replace("2026-10-13", "")).not.toMatch(/\d/);
    const s2 = documentEmailText(summary, { orgName: "Synthetic Clinic", recipientName: null, provisional: false });
    expect(s2.subject).toBe("Synthetic Clinic: monthly finance summary, September 2026");
    expect(s2.text.replace("September 2026", "")).not.toMatch(/\d|AED/);
    expect(documentFilename(flash)).toBe("flash-report-2026-10-13.xlsx");
    expect(documentFilename(summary)).toBe("finance-summary-2026-09.xlsx");
  });

  it("words an invoice copy with its number and date, never an amount", () => {
    const t = documentEmailText(
      { kind: "sales_invoice", customer_id: CUSTOMER, invoice_id: INVOICE },
      {
        orgName: "Synthetic Clinic",
        recipientName: "Synthetic Corporate LLC",
        reference: { number: "SI/2026-27/00001", date: "2026-09-30", creditNote: false },
      },
    );
    expect(t.subject).toBe("Synthetic Clinic: copy of invoice SI/2026-27/00001");
    expect(t.text).toContain("Dear Synthetic Corporate LLC,");
    expect(t.text).not.toMatch(/AED/);
    expect(
      documentFilename(
        { kind: "sales_invoice", customer_id: CUSTOMER, invoice_id: INVOICE },
        { number: "SI/2026-27/00001" },
      ),
    ).toBe("SI-2026-27-00001-copy.pdf");
  });

  it("refuses a member who no longer holds the report's permission, before rendering", async () => {
    let rendered = false;
    const { p, sent } = ports({
      recipient: async () => "not_allowed",
      render: async () => {
        rendered = true;
        return { attachment };
      },
    });
    await expect(runDocumentEmail(job({ document: flash }), p)).resolves.toBe("recipient_not_allowed");
    expect(rendered).toBe(false);
    expect(sent).toEqual([]);
    expect(OUTCOME_NOTICE.recipient_not_allowed).not.toMatch(/@/);
  });
});

describe("runDocumentEmail", () => {
  it("sends the rendered document to the confirmed address with the request as idempotency key", async () => {
    const { p, sent } = ports();
    await expect(runDocumentEmail(job(), p)).resolves.toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: ADDRESS,
      idempotencyKey: `pulse-findoc-${REQUEST}`,
      attachments: [attachment],
    });
  });

  it("refuses when the address changed after it was confirmed, or is gone, without rendering", async () => {
    const render = vi.fn(async () => ({ attachment }));
    const changed = ports({
      recipient: async () => ({ email: "other@x.example.test", name: null }),
      render,
    });
    await expect(runDocumentEmail(job(), changed.p)).resolves.toBe("recipient_changed");
    const gone = ports({ recipient: async () => null, render });
    await expect(runDocumentEmail(job(), gone.p)).resolves.toBe("recipient_missing");
    expect(render).not.toHaveBeenCalled();
    expect(changed.sent).toHaveLength(0);
    expect(OUTCOME_NOTICE.recipient_changed).not.toMatch(/@/);
  });

  it("reports a missing document and an unconfigured mailer; a failed send throws so the queue retries", async () => {
    await expect(runDocumentEmail(job(), ports({ render: async () => null }).p)).resolves.toBe(
      "document_missing",
    );
    const off = ports({ send: async () => ({ delivered: false, reason: "email_not_configured" }) });
    await expect(runDocumentEmail(job(), off.p)).resolves.toBe("not_configured");
    const down = ports({ send: async () => ({ delivered: false, reason: "rate limited" }) });
    await expect(runDocumentEmail(job(), down.p)).rejects.toThrow(/rate limited/);
  });

  describe("through sendEmail with a fake transport", () => {
    beforeEach(() => {
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role");
      vi.stubEnv("JOB_SECRET", "test-job-secret-0123456789");
    });
    afterEach(() => vi.unstubAllEnvs());

    it("hands Resend's transport the PDF attachment and the key", async () => {
      const calls: Array<{ payload: EmailPayload; key?: string }> = [];
      const transport: EmailTransport = async (payload, options) => {
        calls.push({ payload, key: options.idempotencyKey });
        return { id: "fake-2" };
      };
      const { p } = ports({ send: (m) => sendEmail(m, { transport }) });
      await expect(runDocumentEmail(job(), p)).resolves.toBe("sent");
      expect(calls).toHaveLength(1);
      expect(calls[0].key).toBe(`pulse-findoc-${REQUEST}`);
      expect(calls[0].payload.attachments?.[0]).toMatchObject({
        filename: attachment.filename,
        contentType: "application/pdf",
      });
    });
  });
});
