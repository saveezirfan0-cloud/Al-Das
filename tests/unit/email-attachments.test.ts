/**
 * Phase G: e-mail with attachments (lib/email.ts). Always a fake transport: no test may reach Resend (tests/setup.ts
 * blocks the host).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  attachmentProblem,
  MAX_ATTACHMENT_BYTES,
  sendEmail,
  type EmailPayload,
  type EmailTransport,
} from "@/lib/email";

const pdf = (n = 10) => ({
  filename: "statement-2026-01-01-2026-09-30.pdf",
  content: new Uint8Array(n).fill(37),
  contentType: "application/pdf",
});

function fakeTransport(answer: Awaited<ReturnType<EmailTransport>> = { id: "fake-1" }) {
  const calls: Array<{ payload: EmailPayload; options: { idempotencyKey?: string } }> = [];
  const transport: EmailTransport = async (payload, options) => {
    calls.push({ payload, options });
    return answer;
  };
  return { transport, calls };
}

describe("attachmentProblem", () => {
  it("accepts Pulse's own document types and refuses anything else", () => {
    expect(attachmentProblem(undefined)).toBeNull();
    expect(attachmentProblem([pdf()])).toBeNull();
    expect(
      attachmentProblem([
        {
          ...pdf(),
          filename: "book.xlsx",
          contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      ]),
    ).toBeNull();
    expect(attachmentProblem([{ ...pdf(), contentType: "text/html" }])).toBe("bad_attachment_type");
    expect(attachmentProblem([{ ...pdf(), filename: "../etc/passwd" }])).toBe(
      "bad_attachment_name",
    );
    expect(attachmentProblem([{ ...pdf(), filename: "a b.pdf" }])).toBe("bad_attachment_name");
    expect(attachmentProblem([pdf(0)])).toBe("empty_attachment");
    expect(attachmentProblem(Array.from({ length: 6 }, () => pdf()))).toBe("too_many_attachments");
    expect(attachmentProblem([pdf(MAX_ATTACHMENT_BYTES + 1)])).toBe("attachments_too_large");
  });
});

describe("sendEmail", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role");
    vi.stubEnv("JOB_SECRET", "test-job-secret-0123456789");
    vi.stubEnv("RESEND_API_KEY", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("passes attachments in Resend's shape with the idempotency key", async () => {
    const { transport, calls } = fakeTransport();
    const res = await sendEmail(
      {
        to: "accounts@insurer.example.test",
        subject: "Statement",
        text: "Attached.",
        attachments: [pdf(4)],
        idempotencyKey: "pulse-findoc-1",
      },
      { transport, from: "Pulse <no-reply@clinic.example.test>" },
    );
    expect(res).toEqual({ delivered: true, id: "fake-1" });
    expect(calls).toHaveLength(1);
    const [{ payload, options }] = calls;
    expect(options).toEqual({ idempotencyKey: "pulse-findoc-1" });
    expect(payload.from).toBe("Pulse <no-reply@clinic.example.test>");
    expect(payload.attachments).toHaveLength(1);
    expect(Buffer.isBuffer(payload.attachments![0].content)).toBe(true);
    expect(payload.attachments![0]).toMatchObject({
      filename: "statement-2026-01-01-2026-09-30.pdf",
      contentType: "application/pdf",
    });
  });

  it("sends no attachments key for a plain message", async () => {
    const { transport, calls } = fakeTransport();
    await sendEmail({ to: "a@b.example.test", subject: "Hi", text: "Hello" }, { transport });
    expect("attachments" in calls[0].payload).toBe(false);
    expect(calls[0].options).toEqual({});
  });

  it("refuses bad attachments before anything is sent", async () => {
    const { transport, calls } = fakeTransport();
    const res = await sendEmail(
      {
        to: "a@b.example.test",
        subject: "x",
        text: "y",
        attachments: [{ ...pdf(), contentType: "image/svg+xml" }],
      },
      { transport },
    );
    expect(res).toEqual({ delivered: false, reason: "bad_attachment_type" });
    expect(calls).toHaveLength(0);
  });

  it("reports a provider error without throwing, and logs no body or file name", async () => {
    const { transport } = fakeTransport({
      error: { name: "validation_error", message: "bad from" },
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await sendEmail(
      { to: "person@b.example.test", subject: "x", text: "secret body", attachments: [pdf()] },
      { transport },
    );
    expect(res).toEqual({ delivered: false, reason: "bad from" });
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain("secret body");
    expect(logged).not.toContain("statement-2026");
    expect(logged).not.toContain("person@");
    spy.mockRestore();
  });

  it("keeps the no-key behaviour: nothing sent, delivered false, a redacted log line", async () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    const res = await sendEmail({
      to: "person@b.example.test",
      subject: "x",
      text: "y",
      attachments: [pdf()],
    });
    expect(res).toEqual({ delivered: false, reason: "email_not_configured" });
    expect(JSON.stringify(spy.mock.calls)).not.toContain("person@");
    spy.mockRestore();
  });
});
