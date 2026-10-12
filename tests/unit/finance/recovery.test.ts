import { describe, expect, it } from "vitest";

import {
  planReminders,
  recoveryReadiness,
  recoveryValues,
  type BalanceRow,
  type PriorReminder,
  type RecoveryPerson,
  type RecoverySettings,
  type RecoveryTarget,
} from "@/lib/finance/recovery";
import { templateWordingHash } from "@/lib/finance/recovery-approval";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

const NOW = new Date("2026-10-21T04:00:00Z");
const settings: RecoverySettings = {
  minBalance: 50,
  minDaysOverdue: 14,
  gapDays: 14,
  maxReminders: 3,
  batchSize: 50,
};

const person = (over: Partial<RecoveryPerson> = {}): RecoveryPerson => ({
  id: "p1",
  first_name: "Layla",
  phone_e164: "+447700900001",
  wa_bsuid: null,
  promotions_opt_in: true,
  stop_marketing: false,
  ...over,
});
const balance = (over: Partial<BalanceRow> = {}): BalanceRow => ({
  invoice_id: "i1",
  inv_display_number: "ADMC/C/80001",
  patient_pin: "PIN-R1",
  transaction_date: "2026-09-01",
  branch_code: "P",
  balance: 120,
  days_old: 50,
  ...over,
});
const targets = (t: Record<string, RecoveryTarget | null>) => new Map(Object.entries(t));
const self = (p: RecoveryPerson): RecoveryTarget => ({
  recipient: p,
  patient: p,
  viaGuardian: false,
});

const run = (
  b: BalanceRow[],
  priors: PriorReminder[],
  t: Record<string, RecoveryTarget | null>,
  s = settings,
) => planReminders({ balances: b, priors, targets: targets(t), settings: s, now: NOW });

describe("planReminders", () => {
  it("plans a first reminder for an opted-in patient with an overdue balance", () => {
    const r = run([balance()], [], { "PIN-R1": self(person()) });
    expect(r.plans).toEqual([
      expect.objectContaining({
        invoiceId: "i1",
        sequence: 1,
        recipientId: "p1",
        viaGuardian: false,
        balance: 120,
      }),
    ]);
    expect(r.skipped).toEqual([]);
  });

  it("requires opt-in and honours stop_marketing (stop wins over opt-in)", () => {
    expect(
      run([balance()], [], { "PIN-R1": self(person({ promotions_opt_in: false })) }).skipped,
    ).toEqual([{ invoiceId: "i1", reason: "no_opt_in" }]);
    expect(
      run([balance()], [], { "PIN-R1": self(person({ stop_marketing: true })) }).skipped,
    ).toEqual([{ invoiceId: "i1", reason: "stop_marketing" }]);
    expect(
      run([balance()], [], {
        "PIN-R1": self(person({ stop_marketing: true, promotions_opt_in: true })),
      }).plans,
    ).toEqual([]);
  });

  it("needs a WhatsApp identifier, and a BSUID alone is enough", () => {
    expect(
      run([balance()], [], { "PIN-R1": self(person({ phone_e164: null })) }).skipped[0].reason,
    ).toBe("no_whatsapp_id");
    expect(
      run([balance()], [], { "PIN-R1": self(person({ phone_e164: null, wa_bsuid: "BS-1" })) })
        .plans,
    ).toHaveLength(1);
    expect(run([balance()], [], {}).skipped[0].reason).toBe("no_patient_record");
  });

  it("judges the person who RECEIVES the message: a guardian's opt-in covers a dependant", () => {
    const guardian = person({ id: "g1", first_name: "Omar's mum" });
    const child = person({
      id: "c1",
      first_name: "Omar",
      phone_e164: null,
      promotions_opt_in: false,
    });
    const r = run([balance()], [], {
      "PIN-R1": { recipient: guardian, patient: child, viaGuardian: true },
    });
    expect(r.plans[0]).toMatchObject({ recipientId: "g1", viaGuardian: true });
    const noOpt = {
      recipient: person({ id: "g2", promotions_opt_in: false }),
      patient: child,
      viaGuardian: true,
    };
    expect(run([balance()], [], { "PIN-R1": noOpt }).skipped[0].reason).toBe("no_opt_in");
  });

  it("applies the thresholds from settings", () => {
    expect(
      run([balance({ balance: 49.99 })], [], { "PIN-R1": self(person()) }).skipped[0].reason,
    ).toBe("balance_below_minimum");
    expect(run([balance({ balance: 50 })], [], { "PIN-R1": self(person()) }).plans).toHaveLength(1);
    expect(
      run([balance({ days_old: 13 })], [], { "PIN-R1": self(person()) }).skipped[0].reason,
    ).toBe("not_overdue_yet");
    expect(
      run(
        [balance({ days_old: 13 })],
        [],
        { "PIN-R1": self(person()) },
        { ...settings, minDaysOverdue: 10 },
      ).plans,
    ).toHaveLength(1);
  });

  it("spaces reminders by the gap and stops at the maximum", () => {
    const sent = (n: number, daysAgo: number): PriorReminder => ({
      invoice_id: "i1",
      sequence_no: n,
      status: "queued",
      created_at: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(),
    });
    expect(run([balance()], [sent(1, 13)], { "PIN-R1": self(person()) }).skipped[0].reason).toBe(
      "reminded_recently",
    );
    const second = run([balance()], [sent(1, 14)], { "PIN-R1": self(person()) });
    expect(second.plans[0].sequence).toBe(2);
    expect(
      run([balance()], [sent(1, 60), sent(2, 40), sent(3, 20)], { "PIN-R1": self(person()) })
        .skipped[0].reason,
    ).toBe("max_reminders_reached");
  });

  it("does not count failed attempts as reminders, so a failure is retried with the same sequence number", () => {
    const failed: PriorReminder = {
      invoice_id: "i1",
      sequence_no: 1,
      status: "failed",
      created_at: NOW.toISOString(),
    };
    const r = run([balance()], [failed], { "PIN-R1": self(person()) });
    expect(r.plans[0].sequence).toBe(1);
  });

  it("caps a run at the batch size and says what was held back", () => {
    const many = ["a", "b", "c"].map((id) => balance({ invoice_id: id, patient_pin: `PIN-${id}` }));
    const t = Object.fromEntries(
      many.map((b) => [b.patient_pin, self(person({ id: b.invoice_id }))]),
    );
    const r = run(many, [], t, { ...settings, batchSize: 2 });
    expect(r.plans).toHaveLength(2);
    expect(r.skipped).toEqual([{ invoiceId: "c", reason: "batch_full" }]);
  });
});

describe("template values and approval", () => {
  const components = [
    {
      type: "BODY",
      text: "Hello {{1}}, a balance of {{2}} on invoice {{3}} is still open at {{4}}. Reply HELP for options.",
      example: { body_text: [["Layla", "AED 120.00", "ADMC/C/80001", "Demo Clinic"]] },
    },
    { type: "FOOTER", text: "Please ignore this message if you have already paid." },
  ] as unknown as MetaTemplateComponent[];
  const ctx = {
    first_name: "Layla",
    patient_first_name: "Omar",
    amount_due: "AED 120.00",
    invoice_ref: "ADMC/C/80001",
    clinic_name: "Demo Clinic",
    days_overdue: "50",
  };

  it("fills the mapped variables", () => {
    const r = recoveryValues(
      components,
      {
        "body.1": "first_name",
        "body.2": "amount_due",
        "body.3": "invoice_ref",
        "body.4": "clinic_name",
      },
      ctx,
    );
    expect(r.values).toEqual({
      "body.1": "Layla",
      "body.2": "AED 120.00",
      "body.3": "ADMC/C/80001",
      "body.4": "Demo Clinic",
    });
    expect(r.missing).toEqual([]);
  });
  it("reports unmapped variables and refuses unknown sources instead of sending a blank", () => {
    const r = recoveryValues(components, { "body.1": "first_name", "body.2": "diagnosis" }, ctx);
    expect(r.missing).toEqual(["body.2", "body.3", "body.4"]);
  });
  it("cannot use a template with a media header or a button variable", () => {
    const withMedia = [
      { type: "HEADER", format: "IMAGE", example: { header_handle: ["h"] } },
      ...components,
    ] as unknown as MetaTemplateComponent[];
    expect(recoveryValues(withMedia, {}, ctx).unsupported).toContain("header.media");
  });

  it("binds the tone approval to the exact wording", () => {
    const a = templateWordingHash(components);
    expect(templateWordingHash(components)).toBe(a);
    const edited = [
      { ...(components[0] as object), text: "Hello {{1}}, pay {{2}} now {{3}} {{4}}" },
      components[1],
    ] as unknown as MetaTemplateComponent[];
    expect(templateWordingHash(edited)).not.toBe(a);
    // examples are not wording
    const reExampled = [
      { ...(components[0] as object), example: { body_text: [["x", "y", "z", "w"]] } },
      components[1],
    ] as unknown as MetaTemplateComponent[];
    expect(templateWordingHash(reExampled)).toBe(a);
  });

  it("lists what blocks switching the feature on", () => {
    expect(
      recoveryReadiness({
        templateStatus: null,
        mappedAll: false,
        toneApprovedHash: null,
        currentHash: null,
      }),
    ).toHaveLength(3);
    expect(
      recoveryReadiness({
        templateStatus: "PENDING",
        mappedAll: true,
        toneApprovedHash: "h",
        currentHash: "h",
      }),
    ).toEqual(["The template is not approved by Meta."]);
    expect(
      recoveryReadiness({
        templateStatus: "APPROVED",
        mappedAll: true,
        toneApprovedHash: "old",
        currentHash: "new",
      })[0],
    ).toMatch(/changed/);
    expect(
      recoveryReadiness({
        templateStatus: "APPROVED",
        mappedAll: true,
        toneApprovedHash: "h",
        currentHash: "h",
      }),
    ).toEqual([]);
  });
});
