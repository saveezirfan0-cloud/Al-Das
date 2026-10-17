/**
 * The Campaigns message logs (docs/45 P1): Chronic Recall and Birthday Messages → recall_sends, Appointment Messages →
 * appointment_reminders and early birthday sends → recall_sends. In-memory store, synthetic records only.
 * What matters: a cycle that Make already messaged is blocked in Pulse, a reminder Make already sent is recorded, nothing
 * is guessed (patients are found by link, then PIN), nothing is duplicated, and only real columns reach the database.
 */
import { describe, expect, it } from "vitest";

import type { AirtableRecord } from "../../scripts/import/airtable-client";
import { runImport } from "../../scripts/import/orchestrator";
import { entityMap } from "../../scripts/import/registry";
import type { AirtableSource } from "../../scripts/import/results";
import { MemoryStore } from "../../scripts/import/store";

const CAMPAIGNS = "appkOnjPr1SMD83CP";
const T = {
  chronic: `${CAMPAIGNS}.tbldCbNEKeF5NrTCs`,
  birthday: `${CAMPAIGNS}.tblHTlF6LXMK5p4mU`,
  appt: `${CAMPAIGNS}.tblhoSfiSjO4zh9cf`,
};

const rec = (id: string, fields: Record<string, unknown>): AirtableRecord => ({
  id,
  createdTime: "2026-01-01T00:00:00.000Z",
  fields,
});

const chronic = (id: string, over: Record<string, unknown>) =>
  rec(id, {
    fldWUAkSRmbstj93Q: "Sent",
    fldO6ql2L51mNEmJt: "Live",
    fld01KXt1biCwWS55: "2026-09-02T06:00:00.000Z",
    fld6a8W0nUzktk9o5: "2026-05-20",
    fldvLFVogNna9clyG: "Hypertension / Hypertensive disease",
    ...over,
  });

const DATA: Record<string, AirtableRecord[]> = {
  [T.chronic]: [
    chronic("recC1", { fldFD99GmktfyJ7Xa: "recP1", fldmqIT40DYyGAe8q: "PIN-WRONG" }), // by Airtable record, the PIN is ignored
    chronic("recC2", { fldFD99GmktfyJ7Xa: "recP2", fld6a8W0nUzktk9o5: "2026-06-01" }), // by record: the contact was merged into c1
    chronic("recC3", { fldmqIT40DYyGAe8q: "NOBODY" }), // not in Pulse
    chronic("recC4", { fldFD99GmktfyJ7Xa: "recP1", fldWUAkSRmbstj93Q: "Queued" }), // unknown status
    chronic("recC5", {
      fldFD99GmktfyJ7Xa: "recP1",
      fld6a8W0nUzktk9o5: "2026-01-10",
      fldqgbYSfHGYq8LVV: "Booked",
      fldhv2BcULV9m5k97: "2026-09-10",
      fldY4zg5P4pTRFD90: "Yes",
      fld1VuzlSX4IrKblI: "2026-09-04",
      fldoG6VR5IIm5I2b5: "Sent to: +447700900123",
      fldvLFVogNna9clyG: "Something unlisted",
    }),
  ],
  [T.birthday]: [
    rec("recB1", {
      fldUYm1BW2qck0zTm: "PIN1",
      fldJA8wk04TfEVCAm: "2026-03-04",
      fld6Rlp4uzQLuJf3m: 34,
    }),
    rec("recB2", { fldUYm1BW2qck0zTm: "PIN1", fldJA8wk04TfEVCAm: "2026-03-04" }), // the same year again
    rec("recB3", { fldUYm1BW2qck0zTm: "PIN1", fldJA8wk04TfEVCAm: "04/03/2025" }), // legacy day-first
    rec("recB4", { fldUYm1BW2qck0zTm: "PIN1" }), // no send date → invalid
  ],
  [T.appt]: [
    rec("recA1", {
      fldjRghFRS8xkpkWa: "UA-1",
      fld5m4VQXx6JQYAIk: "2026-09-03",
      fldlE1a7BlurxGn1c: "Appointment",
    }),
    rec("recA2", {
      fldjRghFRS8xkpkWa: "UA-404",
      fld5m4VQXx6JQYAIk: "2026-09-03",
      fldlE1a7BlurxGn1c: "Appointment",
    }),
    rec("recA3", { fldjRghFRS8xkpkWa: "UA-1", fldlE1a7BlurxGn1c: "Appointment" }), // not sent
    rec("recA4", {
      fldkmbCGn5ovZIxHF: "PIN1",
      fld5m4VQXx6JQYAIk: "2026-03-04", // same patient and year as recB1
      fldlE1a7BlurxGn1c: "Birthday",
    }),
    rec("recA5", {
      fldkmbCGn5ovZIxHF: "PIN1",
      fld5m4VQXx6JQYAIk: "2024-04-02", // a year the Birthday table does not have
      fldlE1a7BlurxGn1c: "Birthday",
      fldkI33eF320eoe0F: "free text that must never be stored",
    }),
  ],
};

const source: AirtableSource = {
  async tableFields() {
    return [];
  },
  async *records(base, table) {
    for (const r of DATA[`${base}.${table}`] ?? []) yield r;
  },
};

const ONLY = [
  "campaigns.chronic_recall",
  "campaigns.birthday",
  "campaigns.appointment_messages",
  "campaigns.appointment_messages_birthday",
];

async function seeded(withProgrammes = true) {
  const store = new MemoryStore();
  const e = entityMap();
  if (withProgrammes) {
    await store.insertRow("recall_programmes", { key: "chronic_90d" });
    await store.insertRow("recall_programmes", { key: "birthday" });
  }
  await store.insertRow("ref_condition_groups", {
    key: "hypertension",
    name: "Hypertension / Hypertensive disease",
  });
  const c1 = (await store.insertRow("contacts", {
    external_id: "PIN1",
    deleted_at: null,
    merged_into_id: null,
  })) as { id: string };
  const gone = (await store.insertRow("contacts", {
    external_id: "PIN2",
    deleted_at: null,
    merged_into_id: c1.id,
  })) as { id: string };
  await store.upsertRef({
    entity: e.get("unite.patients")!,
    externalId: "recP1",
    localTable: "contacts",
    localId: c1.id,
  });
  await store.upsertRef({
    entity: e.get("unite.patients")!,
    externalId: "recP2",
    localTable: "contacts",
    localId: gone.id,
  });
  const appt = (await store.insertRow("appointments", {
    source: "unite",
    external_id: "UA-1",
  })) as { id: string };
  return { store, c1: c1.id, appt: appt.id };
}

const COLUMNS = {
  recall_sends: new Set([
    "org_id",
    "id",
    "programme_id",
    "contact_id",
    "cycle_key",
    "segment_key",
    "legacy_template_ref",
    "send_mode",
    "status",
    "sent_at",
    "last_visit_date_at_send",
    "days_since_last_visit_at_send",
    "replied_at",
    "booked_at",
    "follow_up_status",
    "notes",
    "source",
  ]),
  appointment_reminders: new Set([
    "org_id",
    "id",
    "appointment_id",
    "idx",
    "due_at",
    "sent_at",
    "status",
  ]),
};

describe("message log importers", () => {
  it("writes the cycles Make already messaged and the reminders it already sent", async () => {
    const { store, c1, appt } = await seeded();
    const run = await runImport(
      { store, source },
      { dryRun: false, includeTest: false, only: ONLY },
    );
    const by = Object.fromEntries(run.results.map((r) => [r.key, r]));

    // chronic: C1 and C5 by record, C2 by the merged contact (followed to c1); C3 not in Pulse, C4 unknown status
    expect(by["campaigns.chronic_recall"].counters).toMatchObject({
      read: 5,
      created: 3,
      skipped: 1,
      invalid: 1,
      failed: 0,
    });
    expect(by["campaigns.chronic_recall"].warnings.patient_not_in_pulse).toBe(1);
    expect(by["campaigns.chronic_recall"].warnings.unknown_send_status).toBe(1);
    const sends = store.rows("recall_sends");
    const chronicSends = sends.filter(
      (r) => r.programme_id === store.rows("recall_programmes")[0]!.id,
    );
    expect(
      chronicSends.map((r) => [r.cycle_key, r.contact_id === c1, r.segment_key ?? null]).sort(),
    ).toEqual([
      ["2026-01-10", true, null],
      ["2026-05-20", true, "hypertension"],
      ["2026-06-01", true, "hypertension"],
    ]);
    const booked = chronicSends.find((r) => r.cycle_key === "2026-01-10")!;
    expect(booked).toMatchObject({
      follow_up_status: "booked",
      booked_at: "2026-09-10",
      replied_at: "2026-09-04",
      status: "sent",
      send_mode: "live",
      source: "airtable_import",
    });
    expect(booked.notes).toBeUndefined(); // "Sent to: <number>" is dropped

    // birthday: the repeat in 2026 is a duplicate, the legacy day-first date is 2025, the row without a date is invalid
    expect(by["campaigns.birthday"].counters).toMatchObject({
      read: 4,
      created: 2,
      duplicates: 1,
      invalid: 1,
      failed: 0,
    });
    const bday = sends.filter((r) => r.programme_id === store.rows("recall_programmes")[1]!.id);
    expect(bday.map((r) => r.cycle_key).sort()).toEqual(["2024", "2025", "2026"]);

    // reminders: only for the appointment Pulse has, noon Dubai, number 1
    expect(by["campaigns.appointment_messages"].counters).toMatchObject({
      read: 5,
      created: 1,
      skipped: 4,
      failed: 0,
    });
    expect(by["campaigns.appointment_messages"].warnings).toMatchObject({
      appointment_not_in_pulse: 1,
      reminder_not_sent: 1,
      birthday_row_handled_by_birthday_log_mapper: 2,
    });
    expect(store.rows("appointment_reminders")).toEqual([
      expect.objectContaining({
        appointment_id: appt,
        idx: 1,
        status: "sent",
        sent_at: "2026-09-03T08:00:00.000Z",
        due_at: "2026-09-03T08:00:00.000Z",
      }),
    ]);

    // early birthday sends: recA4 duplicates the Birthday table's 2026 send (adopted, not doubled); recA5 is new (2025, via the merged contact)
    expect(by["campaigns.appointment_messages_birthday"].counters).toMatchObject({
      read: 5,
      skipped: 3,
      failed: 0,
    });
    expect(bday.length + 0).toBe(3);
    expect(
      store
        .rows("recall_sends")
        .filter((r) => r.programme_id === store.rows("recall_programmes")[1]!.id),
    ).toHaveLength(3);

    // only real columns reach the database, no helper columns, no free text
    for (const r of store.rows("recall_sends"))
      for (const k of Object.keys(r))
        expect(COLUMNS.recall_sends.has(k), `recall_sends.${k}`).toBe(true);
    for (const r of store.rows("appointment_reminders"))
      for (const k of Object.keys(r))
        expect(COLUMNS.appointment_reminders.has(k), `appointment_reminders.${k}`).toBe(true);
    expect(JSON.stringify([...store.tables.values()])).not.toContain("must never be stored");
  });

  it("is idempotent and create-only: a second run changes nothing, and staff edits survive", async () => {
    const { store } = await seeded();
    await runImport({ store, source }, { dryRun: false, includeTest: false, only: ONLY });
    const before = JSON.stringify([
      store.rows("recall_sends"),
      store.rows("appointment_reminders"),
    ]);
    const mine = store.rows("recall_sends")[0]!;
    mine.follow_up_status = "no_response"; // staff worked the row in Pulse
    const second = await runImport(
      { store, source },
      { dryRun: false, includeTest: false, only: ONLY },
    );
    expect(store.rows("recall_sends")).toHaveLength(JSON.parse(before)[0].length);
    expect(store.rows("appointment_reminders")).toHaveLength(1);
    expect(store.rows("recall_sends")[0]!.follow_up_status).toBe("no_response");
    for (const r of second.results) expect(r.counters.created, r.key).toBe(0);
  });

  it("a dry run writes nothing", async () => {
    const { store } = await seeded();
    await runImport({ store, source }, { dryRun: true, includeTest: false, only: ONLY });
    expect(store.rows("recall_sends")).toHaveLength(0);
    expect(store.rows("appointment_reminders")).toHaveLength(0);
  });

  it("without the recall programmes the rows are invalid, not written with a missing programme", async () => {
    const { store } = await seeded(false);
    const run = await runImport(
      { store, source },
      {
        dryRun: false,
        includeTest: false,
        only: ["campaigns.chronic_recall", "campaigns.birthday"],
      },
    );
    expect(store.rows("recall_sends")).toHaveLength(0);
    for (const r of run.results) expect(r.counters.created, r.key).toBe(0);
    expect(run.results[0]!.warnings.programme_missing).toBeGreaterThan(0);
  });
});
