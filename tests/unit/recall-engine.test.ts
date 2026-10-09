import { describe, expect, it } from "vitest";

import { effectiveMode, parseOrderBy, parseTestNumbers, renderValues, runProgramme } from "@/lib/recall/engine";
import { isBookingButton, outcomeForButton, pickBookingTarget, pickReplyTarget, type OpenSend } from "@/lib/recall/replies";
import type { EligibleRow, NewSend, ProgrammeRow, RecallContact, RecallDeps, RecallStore, TemplateMapRow } from "@/lib/recall/types";

const ORG = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-09T08:00:00.000Z");
const TPL_OK = "00000000-0000-4000-8000-0000000000a1";
const TPL_PENDING = "00000000-0000-4000-8000-0000000000a2";

function programme(over: Partial<ProgrammeRow> = {}): ProgrammeRow {
  return {
    id: "00000000-0000-4000-8000-0000000000b1",
    org_id: ORG,
    key: "birthday",
    name: "Birthday",
    kind: "birthday",
    status: "active",
    eligibility_view: "v_birthday_today",
    cron_expression: "0 9 * * *",
    repeat_policy: "per_cycle",
    max_per_run: 100,
    send_mode_override: null,
    requires_marketing_opt_in: true,
    requires_clinical_consent: false,
    config: {},
    last_run_at: null,
    ...over,
  };
}

function contact(id: string, over: Partial<RecallContact> = {}): RecallContact {
  return {
    id,
    first_name: "Sara",
    last_name: "Test",
    full_name: "Sara Test",
    phone_e164: `+97150000${id.slice(-4)}`,
    stop_marketing: false,
    promotions_opt_in: true,
    clinical_messaging_consent: true,
    is_test_record: false,
    ...over,
  };
}

const cid = (n: number) => `00000000-0000-4000-8000-00000000${String(n).padStart(4, "0")}`;

class FakeRecallStore implements RecallStore {
  prog: ProgrammeRow;
  settings: Record<string, string | null> = {};
  rows: EligibleRow[] = [];
  map: TemplateMapRow[] = [
    { id: "m1", segment_key: "f_18_35", wa_template_id: TPL_OK, legacy_sanoflow_template_id: "12289", variables_map: { "body.1": "contact.first_name|default:Patient" }, active: true },
  ];
  templates = new Map([
    [TPL_OK, { id: TPL_OK, name: "birthday", status: "APPROVED", category: "MARKETING" }],
    [TPL_PENDING, { id: TPL_PENDING, name: "pending", status: "PENDING", category: "MARKETING" }],
  ]);
  contacts = new Map<string, RecallContact>();
  sends: Array<NewSend & { id: string; message_id?: string | null; sent_at?: string | null }> = [];
  tags: Array<[string, string]> = [];
  touched = 0;
  constructor(p: ProgrammeRow) {
    this.prog = p;
  }
  async getProgramme() {
    return this.prog;
  }
  async setting(_o: string, key: string) {
    return this.settings[key] ?? null;
  }
  async listEligible() {
    return this.rows;
  }
  async templateMap() {
    return this.map;
  }
  async template(_o: string, id: string) {
    return this.templates.get(id) ?? null;
  }
  async contact(_o: string, id: string) {
    return this.contacts.get(id) ?? null;
  }
  async insertSend(row: NewSend) {
    if (this.sends.some((s) => s.programme_id === row.programme_id && s.contact_id === row.contact_id && s.cycle_key === row.cycle_key)) return null;
    const rec = { ...row, id: `s${this.sends.length + 1}` };
    this.sends.push(rec);
    return { id: rec.id };
  }
  async updateSend(id: string, patch: Record<string, unknown>) {
    Object.assign(this.sends.find((s) => s.id === id)!, patch);
  }
  async testContacts(_o: string, phones: string[]) {
    return phones.map((p, i) => ({ id: cid(900 + i), phone_e164: p }));
  }
  async tagContact(_o: string, contactId: string, tag: string) {
    this.tags.push([contactId, tag]);
  }
  async touchProgramme() {
    this.touched += 1;
  }
}

function setup(over: Partial<ProgrammeRow> = {}, n = 3) {
  const store = new FakeRecallStore(programme(over));
  for (let i = 1; i <= n; i++) {
    store.contacts.set(cid(i), contact(cid(i)));
    store.rows.push({ contact_id: cid(i), segment_key: "f_18_35", cycle_key: "2026" });
  }
  const sent: Array<{ contactId: string; waTemplateId: string; values: Record<string, string> }> = [];
  let failNext = false;
  const deps: RecallDeps = {
    store,
    sender: {
      async sendTemplate(i) {
        if (failNext) {
          failNext = false;
          throw new Error("channel paused");
        }
        sent.push({ contactId: i.contactId, waTemplateId: i.waTemplateId, values: i.values });
        return { messageId: `msg${sent.length}` };
      },
    },
    now: () => NOW,
    timezone: "Asia/Dubai",
  };
  return { store, deps, sent, failOnce: () => (failNext = true) };
}

const TEST_NUMBERS = "+971500000901, +971500000902";

describe("helpers", () => {
  it("send mode defaults to test for anything but an explicit live", () => {
    expect(effectiveMode({ send_mode_override: null }, null)).toBe("test");
    expect(effectiveMode({ send_mode_override: null }, "")).toBe("test");
    expect(effectiveMode({ send_mode_override: null }, "Live (Make SEND_MODE variable)")).toBe("test");
    expect(effectiveMode({ send_mode_override: null }, "live")).toBe("live");
    expect(effectiveMode({ send_mode_override: "test" }, "live")).toBe("test");
    expect(effectiveMode({ send_mode_override: "LIVE" }, "test")).toBe("live");
  });
  it("parses only valid E.164 test numbers", () => {
    expect(parseTestNumbers("+971500000001, 0501234567;+971500000002\n+971500000001 junk")).toEqual(["+971500000001", "+971500000002"]);
    expect(parseTestNumbers(null)).toEqual([]);
  });
  it("order_by is allow-listed", () => {
    expect(parseOrderBy("days_since_last_visit desc")).toEqual({ column: "days_since_last_visit", ascending: false });
    expect(parseOrderBy("starts_at ASC")).toEqual({ column: "starts_at", ascending: true });
    expect(parseOrderBy("name; drop table x")).toBeNull();
    expect(parseOrderBy(5)).toBeNull();
  });
  it("renders variables with defaults and appointment fields in the clinic timezone", () => {
    const c = contact(cid(1), { first_name: "" });
    expect(renderValues({ "body.1": "contact.first_name|default:Patient", "body.2": 'appointment.starts_at|date:"DD MMM HH:mm"', "body.3": "appointment.doctor_name" }, c, { contact_id: c.id, segment_key: null, cycle_key: "x", starts_at: "2026-10-12T09:30:00Z", doctor_name: "Dr. Example" }, { timezone: "Asia/Dubai" })).toEqual({
      "body.1": "Patient",
      "body.2": "12 Oct 13:30",
      "body.3": "Dr. Example",
    });
  });
});

describe("runProgramme gates", () => {
  it("does nothing for draft / paused programmes or a non-allow-listed view", async () => {
    for (const over of [{ status: "draft" as const }, { status: "paused" as const }, { eligibility_view: "contacts" }, { eligibility_view: null }]) {
      const { deps, sent, store } = setup(over);
      store.settings.test_recipient_numbers = TEST_NUMBERS;
      const r = await runProgramme(deps, store.prog.id);
      expect(r.blocked).toBeTruthy();
      expect(r.listed).toBe(0);
      expect(sent).toHaveLength(0);
      expect(store.sends).toHaveLength(0);
    }
  });
  it("Test mode without test recipients is blocked (nothing sent, nothing recorded)", async () => {
    const { deps, sent, store } = setup();
    const r = await runProgramme(deps, store.prog.id);
    expect(r).toMatchObject({ mode: "test", blocked: "no_test_recipients" });
    expect(sent).toHaveLength(0);
    expect(store.sends).toHaveLength(0);
  });
  it("Live clinical programmes need clinical_messaging_enabled", async () => {
    const { deps, sent, store } = setup({ kind: "chronic", key: "chronic_90d", eligibility_view: "v_chronic_recall_eligibility", send_mode_override: "live", requires_marketing_opt_in: false, requires_clinical_consent: true });
    store.map = [{ id: "m1", segment_key: "f_18_35", wa_template_id: TPL_OK, legacy_sanoflow_template_id: null, variables_map: {}, active: true }];
    const blocked = await runProgramme(deps, store.prog.id);
    expect(blocked.blocked).toBe("clinical_messaging_disabled");
    expect(sent).toHaveLength(0);
    store.settings.clinical_messaging_enabled = "false";
    expect((await runProgramme(deps, store.prog.id)).blocked).toBe("clinical_messaging_disabled");
    store.settings.clinical_messaging_enabled = "true";
    const ok = await runProgramme(deps, store.prog.id);
    expect(ok.blocked).toBeUndefined();
    expect(ok.queued).toBe(3);
  });
  it("Live non-clinical programmes (birthday) do not need the clinical gate", async () => {
    const { deps, store } = setup({ send_mode_override: "live" });
    expect((await runProgramme(deps, store.prog.id)).queued).toBe(3);
  });
});

describe("Test mode", () => {
  it("delivers only to internal test contacts, never to patients, and caps the delivered sample", async () => {
    const { deps, sent, store } = setup({ config: { test_sample_size: 2 } }, 5);
    store.settings.test_recipient_numbers = TEST_NUMBERS;
    const r = await runProgramme(deps, store.prog.id);
    expect(r).toMatchObject({ mode: "test", listed: 5, queued: 2, recorded_only: 3 });
    expect(sent.map((s) => s.contactId).every((id) => id === cid(900) || id === cid(901))).toBe(true);
    expect(new Set(sent.map((s) => s.contactId)).size).toBe(2); // round-robin over both numbers
    const delivered = store.sends.filter((s) => s.status === "queued");
    expect(delivered.map((s) => s.sent_to_phone_e164).sort()).toEqual(["+971500000901", "+971500000902"]);
    const counted = store.sends.filter((s) => s.status === "eligible");
    expect(counted).toHaveLength(3);
    expect(counted.every((s) => s.sent_to_phone_e164 === null && s.send_mode === "test")).toBe(true);
    expect(store.tags).toEqual([]); // no tags in Test mode
  });
  it("the programme override beats the clinical setting", async () => {
    const { deps, store } = setup({ send_mode_override: "test" });
    store.settings.recall_send_mode = "live";
    store.settings.test_recipient_numbers = TEST_NUMBERS;
    expect((await runProgramme(deps, store.prog.id)).mode).toBe("test");
  });
});

describe("Live mode", () => {
  it("messages the patient, stamps the send, snapshots visit data and tags the contact", async () => {
    const { deps, sent, store } = setup({}, 1);
    store.settings.recall_send_mode = "live";
    store.rows = [{ contact_id: cid(1), segment_key: "f_18_35", cycle_key: "2026", last_visit_date: "2026-05-01", days_since_last_visit: 161 }];
    const r = await runProgramme(deps, store.prog.id);
    expect(r).toMatchObject({ mode: "live", queued: 1 });
    expect(sent[0]).toMatchObject({ contactId: cid(1), waTemplateId: TPL_OK, values: { "body.1": "Sara" } });
    expect(store.sends[0]).toMatchObject({
      status: "queued",
      send_mode: "live",
      legacy_template_ref: "12289",
      last_visit_date_at_send: "2026-05-01",
      days_since_last_visit_at_send: 161,
      message_id: "msg1",
    });
    expect(store.tags).toEqual([[cid(1), "birthday_sent_2026"]]);
    expect(store.touched).toBe(1);
  });
  it("uses the chronic tag", async () => {
    const { deps, store } = setup({ key: "chronic_90d", kind: "chronic", eligibility_view: "v_chronic_recall_eligibility", requires_marketing_opt_in: false, requires_clinical_consent: true, send_mode_override: "live" }, 1);
    store.settings.clinical_messaging_enabled = "true";
    await runProgramme(deps, store.prog.id);
    expect(store.tags).toEqual([[cid(1), "chronic_recall_sent"]]);
  });
});

describe("fail-closed templates", () => {
  it("no mapped template ⇒ skipped_no_template, nothing sent (no default template)", async () => {
    const { deps, sent, store } = setup({ send_mode_override: "live" }, 1);
    store.rows = [{ contact_id: cid(1), segment_key: "unmapped_band", cycle_key: "2026" }];
    const r = await runProgramme(deps, store.prog.id);
    expect(r.skipped_no_template).toBe(1);
    expect(sent).toHaveLength(0);
    expect(store.sends[0]).toMatchObject({ status: "skipped_no_template", notes: "No template mapped for this segment" });
  });
  it("an uncovered (null) segment only matches a '*' row", async () => {
    const { deps, sent, store } = setup({ send_mode_override: "live" }, 1);
    store.rows = [{ contact_id: cid(1), segment_key: null, cycle_key: "2026" }];
    expect((await runProgramme(deps, store.prog.id)).skipped_no_template).toBe(1);
    store.sends.length = 0;
    store.map.push({ id: "star", segment_key: "*", wa_template_id: TPL_OK, legacy_sanoflow_template_id: null, variables_map: {}, active: true });
    expect((await runProgramme(deps, store.prog.id)).queued).toBe(1);
    expect(sent).toHaveLength(1);
  });
  it("unlinked and unapproved templates are not sent", async () => {
    const { deps, sent, store } = setup({ send_mode_override: "live" }, 2);
    store.map = [
      { id: "m1", segment_key: "a", wa_template_id: null, legacy_sanoflow_template_id: "1", variables_map: {}, active: true },
      { id: "m2", segment_key: "b", wa_template_id: TPL_PENDING, legacy_sanoflow_template_id: "2", variables_map: {}, active: true },
    ];
    store.rows = [
      { contact_id: cid(1), segment_key: "a", cycle_key: "2026" },
      { contact_id: cid(2), segment_key: "b", cycle_key: "2026" },
    ];
    const r = await runProgramme(deps, store.prog.id);
    expect(r.skipped_no_template).toBe(2);
    expect(sent).toHaveLength(0);
    expect(store.sends.map((s) => s.notes)).toEqual(["Template not linked yet", "Template not approved"]);
  });
  it("inactive map rows are ignored", async () => {
    const { deps, sent, store } = setup({ send_mode_override: "live" }, 1);
    store.map[0]!.active = false;
    await runProgramme(deps, store.prog.id);
    expect(sent).toHaveLength(0);
  });
});

describe("opt-outs and exclusions", () => {
  it("stop_marketing and missing marketing opt-in are skipped; clinical consent is required in Live", async () => {
    const { deps, sent, store } = setup({ send_mode_override: "live" }, 3);
    store.contacts.set(cid(1), contact(cid(1), { stop_marketing: true }));
    store.contacts.set(cid(2), contact(cid(2), { promotions_opt_in: false }));
    const r = await runProgramme(deps, store.prog.id);
    expect(r).toMatchObject({ skipped_opted_out: 2, queued: 1 });
    expect(sent.map((s) => s.contactId)).toEqual([cid(3)]);

    const clinical = setup({ kind: "chronic", key: "chronic_90d", eligibility_view: "v_chronic_recall_eligibility", requires_marketing_opt_in: false, requires_clinical_consent: true, send_mode_override: "live" }, 2);
    clinical.store.settings.clinical_messaging_enabled = "true";
    clinical.store.contacts.set(cid(1), contact(cid(1), { clinical_messaging_consent: false }));
    const r2 = await runProgramme(clinical.deps, clinical.store.prog.id);
    expect(r2).toMatchObject({ skipped_opted_out: 1, queued: 1 });
  });
  it("stop_marketing blocks even non-marketing programmes' marketing-category templates and every programme requiring opt-in", async () => {
    const { deps, sent, store } = setup({ requires_marketing_opt_in: false, send_mode_override: "live" }, 1);
    store.contacts.set(cid(1), contact(cid(1), { stop_marketing: true }));
    expect((await runProgramme(deps, store.prog.id)).skipped_opted_out).toBe(1);
    expect(sent).toHaveLength(0);
  });
  it("a MARKETING template needs promotions_opt_in even when the programme does not require it", async () => {
    const { deps, sent, store } = setup({ requires_marketing_opt_in: false, send_mode_override: "live" }, 1);
    store.contacts.set(cid(1), contact(cid(1), { promotions_opt_in: false }));
    expect((await runProgramme(deps, store.prog.id)).skipped_opted_out).toBe(1);
    expect(sent).toHaveLength(0);
  });
  it("rows flagged excluded (reminder exclusion list) are recorded, not sent", async () => {
    const { deps, sent, store } = setup({ send_mode_override: "live" }, 1);
    store.rows = [{ contact_id: cid(1), segment_key: "f_18_35", cycle_key: "2026", excluded: true }];
    const r = await runProgramme(deps, store.prog.id);
    expect(r.excluded).toBe(1);
    expect(sent).toHaveLength(0);
    expect(store.sends[0]!.status).toBe("excluded");
  });
});

describe("idempotency and failures", () => {
  it("a second run over the same cycle sends nothing", async () => {
    const { deps, sent, store } = setup({ send_mode_override: "live" }, 3);
    expect((await runProgramme(deps, store.prog.id)).queued).toBe(3);
    const again = await runProgramme(deps, store.prog.id);
    expect(again).toMatchObject({ queued: 0, already_handled: 3 });
    expect(sent).toHaveLength(3);
    expect(store.sends).toHaveLength(3);
  });
  it("a new cycle key (new year / new visit) is eligible again", async () => {
    const { deps, sent, store } = setup({ send_mode_override: "live" }, 1);
    await runProgramme(deps, store.prog.id);
    store.rows = [{ contact_id: cid(1), segment_key: "f_18_35", cycle_key: "2027" }];
    await runProgramme(deps, store.prog.id);
    expect(sent).toHaveLength(2);
  });
  it("a failed queueing marks the send failed and continues with the next patient", async () => {
    const { deps, sent, store, failOnce } = setup({ send_mode_override: "live" }, 2);
    failOnce();
    const r = await runProgramme(deps, store.prog.id);
    expect(r).toMatchObject({ failed: 1, queued: 1 });
    expect(store.sends[0]).toMatchObject({ status: "failed", notes: "channel paused" });
    expect(sent).toHaveLength(1);
    expect(store.tags).toHaveLength(1);
  });
  it("skips contacts that no longer exist", async () => {
    const { deps, store } = setup({ send_mode_override: "live" }, 1);
    store.contacts.clear();
    const r = await runProgramme(deps, store.prog.id);
    expect(r.queued).toBe(0);
    expect(store.sends).toHaveLength(0);
  });
});

describe("reply and booking attribution", () => {
  const at = new Date("2026-10-10T10:00:00Z");
  const send = (id: string, daysAgo: number, over: Partial<OpenSend> = {}): OpenSend => ({
    id,
    sent_at: new Date(at.getTime() - daysAgo * 86_400_000).toISOString(),
    replied_at: null,
    booked_at: null,
    status: "delivered",
    ...over,
  });
  it("credits only the newest open send (Make credited every row)", () => {
    expect(pickReplyTarget([send("old", 9), send("new", 2), send("older", 12)], at)?.id).toBe("new");
  });
  it("respects the attribution window and ignores answered or unsent rows", () => {
    expect(pickReplyTarget([send("x", 20)], at)).toBeNull();
    expect(pickReplyTarget([send("x", 20)], at, 30)?.id).toBe("x");
    expect(pickReplyTarget([send("x", 1, { replied_at: at.toISOString() })], at)).toBeNull();
    expect(pickReplyTarget([send("x", 1, { status: "failed" }), send("y", 1, { status: "queued" })], at)).toBeNull();
    expect(pickReplyTarget([send("future", -1)], at)).toBeNull();
  });
  it("booking uses its own window and skips already-booked sends", () => {
    expect(pickBookingTarget([send("a", 25)], at)?.id).toBe("a");
    expect(pickBookingTarget([send("a", 31)], at)).toBeNull();
    expect(pickBookingTarget([send("a", 3, { booked_at: at.toISOString() }), send("b", 10)], at)?.id).toBe("b");
  });
  it("maps quick-reply buttons to outcomes, with per-programme overrides", () => {
    expect(outcomeForButton(" Book Now ")).toBe("wants_booking");
    expect(outcomeForButton("Claim offer")).toBe("offer_redeemed");
    expect(outcomeForButton("Not interested")).toBe("declined");
    expect(outcomeForButton("Maybe later")).toBeNull();
    expect(outcomeForButton("Maybe later", { "Maybe later": "snoozed" })).toBe("snoozed");
    expect(outcomeForButton("Book now", { "book now": "custom" })).toBe("custom");
    expect(outcomeForButton(null)).toBeNull();
  });
  it("recognises the Book now button", () => {
    expect(isBookingButton(" Book Now ")).toBe(true);
    expect(isBookingButton("No thanks")).toBe(false);
    expect(isBookingButton("Reserve", ["reserve"])).toBe(true);
    expect(isBookingButton(null)).toBe(false);
  });
});
