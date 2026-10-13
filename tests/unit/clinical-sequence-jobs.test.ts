/**
 * Phase 21: a due antibiotic-sequence step on the in-memory admin client. With the clinical messaging gate OFF
 * nothing is sent: the would-send is logged as suppressed_gate, the step records "skipped_gate_off", the status
 * does not move and a retry logs nothing twice. Also the R-17 nurse task, the halted-probiotic guard and test
 * mode with the gate on. Synthetic ids and the reserved +44 7700 900xxx range only.
 */
import { describe, expect, it } from "vitest";

import { processSequenceStep } from "@/lib/clinical/sequence-store";
import type { AdminClient } from "@/lib/supabase/admin";

import { createFakeAdmin } from "../helpers/fake-admin";

const ORG = "00000000-0000-4000-8000-000000000001";
const SEQ = "00000000-0000-4000-8000-0000000000a1";
const RX = "00000000-0000-4000-8000-0000000000b1";
const CONTACT = "00000000-0000-4000-8000-0000000000c1";
const VISIT = "00000000-0000-4000-8000-0000000000d1";

const signed = (key: string, value: string) => ({
  org_id: ORG,
  key,
  approved_value: value,
  proposed_value: value,
  sign_off_status: "approved",
});

function setup(o: { status?: string; gateOpen?: boolean } = {}) {
  const fake = createFakeAdmin(
    {
      orgs: [{ id: ORG, timezone: "Asia/Dubai" }],
      clinical_settings: [
        o.gateOpen
          ? signed("clinical_messaging_enabled", "true")
          : {
              org_id: ORG,
              key: "clinical_messaging_enabled",
              approved_value: null,
              proposed_value: "false",
              sign_off_status: "awaiting",
            },
        // recall_send_mode unsigned → test mode
      ],
      prescription_sequences: [
        {
          id: SEQ,
          org_id: ORG,
          prescription_id: RX,
          status: o.status ?? "not_started",
          antibiotic_end_date: "2026-03-07",
          step_outcomes: {},
        },
      ],
      prescriptions: [
        {
          id: RX,
          org_id: ORG,
          external_key: "MRD-SYN-1-1",
          contact_id: CONTACT,
          visit_id: VISIT,
          is_test_record: false,
        },
      ],
      contacts: [
        {
          id: CONTACT,
          org_id: ORG,
          phone_e164: "+447700900007",
          wa_bsuid: null,
          is_test_record: false,
          clinical_messaging_consent: true,
        },
      ],
      wa_templates: [
        {
          id: "tpl-1",
          org_id: ORG,
          internal_key: "ABX_DAY3",
          clinical_approval: "approved",
          status: "APPROVED",
          components: [],
          channel_id: null,
          waba_id: "waba-1",
          name: "abx_day3",
        },
      ],
      clinical_message_log: [],
      clinical_followups: [],
      messages: [],
    },
    {
      unique: {
        clinical_message_log: [["org_id", "idempotency_key"]],
        clinical_followups: [["org_id", "dedupe_key"]],
      },
    },
  );
  return { fake, admin: fake as unknown as AdminClient };
}

const at = (d: string) => new Date(`${d}T06:00:00Z`); // 10:00 in Dubai

describe("sequence steps", () => {
  it("with the gate OFF logs a suppressed would-send, records 'skipped_gate_off' and sends nothing", async () => {
    const { fake, admin } = setup();
    const r = await processSequenceStep(
      admin,
      { orgId: ORG, sequenceId: SEQ, step: "ABX_DAY3" },
      at("2026-03-03"),
    );
    expect(r).toEqual({ outcome: "skipped_gate_off", reason: "clinical_messaging_not_signed_off" });

    const log = fake._rows("clinical_message_log");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      template_key: "ABX_DAY3",
      idempotency_key: "MRD-SYN-1-1:ABX_DAY3",
      status: "suppressed_gate",
      block_reason: "clinical_messaging_not_signed_off",
      prescription_id: RX,
    });
    expect(fake._rows("messages")).toHaveLength(0);
    const seq = fake._rows("prescription_sequences")[0];
    expect(seq.status).toBe("not_started"); // nothing was sent, so the sequence does not move
    expect((seq.step_outcomes as Record<string, { outcome: string }>).ABX_DAY3.outcome).toBe(
      "skipped_gate_off",
    );

    // a redelivered job logs nothing twice
    const again = await processSequenceStep(
      admin,
      { orgId: ORG, sequenceId: SEQ, step: "ABX_DAY3" },
      at("2026-03-03"),
    );
    expect(again.outcome).toBe("duplicate");
    expect(fake._rows("clinical_message_log")).toHaveLength(1);
  });

  it("with the gate on, test send mode still keeps a real patient out (suppressed_test_record)", async () => {
    const { fake, admin } = setup({ gateOpen: true });
    const r = await processSequenceStep(
      admin,
      { orgId: ORG, sequenceId: SEQ, step: "ABX_DAY3" },
      at("2026-03-03"),
    );
    expect(r.outcome).toBe("suppressed_test_record");
    expect(fake._rows("messages")).toHaveLength(0);
    expect(fake._rows("prescription_sequences")[0].status).toBe("not_started");
  });

  it("never sends PROBIOTIC_START to a halted patient (R-15)", async () => {
    const { fake, admin } = setup({ status: "halted_clinical" });
    const r = await processSequenceStep(
      admin,
      { orgId: ORG, sequenceId: SEQ, step: "PROBIOTIC_START" },
      at("2026-03-08"),
    );
    expect(r).toEqual({ outcome: "skipped_status", reason: "status_halted_clinical" });
    expect(fake._rows("clinical_message_log")).toHaveLength(0);
  });

  it("raises one nurse call task when the day-3 check got no reply by the end of the course (R-17, TP-12)", async () => {
    const { fake, admin } = setup({ status: "awaiting_day3_reply" });
    const r = await processSequenceStep(
      admin,
      { orgId: ORG, sequenceId: SEQ, step: "NO_REPLY_CHECK" },
      at("2026-03-08"),
    );
    expect(r.outcome).toBe("nurse_task");
    await processSequenceStep(
      admin,
      { orgId: ORG, sequenceId: SEQ, step: "NO_REPLY_CHECK" },
      at("2026-03-08"),
    );
    const fu = fake._rows("clinical_followups");
    expect(fu).toHaveLength(1);
    expect(fu[0]).toMatchObject({
      dedupe_key: `noreply-${RX}`,
      source: "sequence",
      prescription_id: RX,
    });
    expect(String(fu[0].notes)).not.toMatch(/\+44|7700/); // no number or name in the task
    expect(fake._rows("clinical_message_log")).toHaveLength(0); // internal only
  });

  it("does nothing for a sequence that no longer exists", async () => {
    const { admin } = setup();
    const r = await processSequenceStep(
      admin,
      { orgId: ORG, sequenceId: "00000000-0000-4000-8000-0000000000ff", step: "ABX_DAY3" },
      at("2026-03-03"),
    );
    expect(r.outcome).toBe("not_found");
  });
});
