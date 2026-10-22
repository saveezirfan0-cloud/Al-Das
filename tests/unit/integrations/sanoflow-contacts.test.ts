import { describe, expect, it } from "vitest";

import type { CallRecord } from "@/lib/integrations/client";
import { createSanoflowClient } from "@/lib/integrations/sanoflow/client";
import {
  readSanoflowConfig,
  SANOFLOW_CONTACTS_ADD_URL,
  SANOFLOW_CONTACTS_EDIT_URL,
  SANOFLOW_CONTACTS_URL,
} from "@/lib/integrations/sanoflow/config";
import {
  answerSaysInvalidChannel,
  contactFullName,
  firstLastWord,
  mergeTags,
  parseContactList,
  planContactEdits,
  readAddedContactId,
  readOutboundContext,
  shouldRecoverInvalidChannel,
  shouldTagAfterSend,
} from "@/lib/integrations/sanoflow/contacts";

// Synthetic values only (CLAUDE.md rule 10).
const KEY = "sanoflow-test-key-not-real";
const INVALID = {
  error: "Bad Request",
  message: "Invalid channel details.",
  documentation_url: "https://developers.sanoflow.io/?api=messaging",
};

function client(answers: Array<{ status: number; json?: unknown } | "timeout">) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const a = answers[Math.min(i++, answers.length - 1)]!;
    if (a === "timeout") {
      const e = new Error("timed out");
      e.name = "TimeoutError";
      throw e;
    }
    return new Response(a.json === undefined ? "" : JSON.stringify(a.json), { status: a.status });
  }) as unknown as typeof fetch;
  const records: CallRecord[] = [];
  const c = createSanoflowClient({
    accessToken: KEY,
    fetchFn,
    sleep: async () => undefined,
    sink: { record: (r) => void records.push(r) },
  })!;
  return { c, calls, records };
}

const LIST = {
  contact_list: {
    data: [
      {
        contact_id: 77,
        first_name: "Layla",
        last_name: "Demo-07",
        tags: [{ tag_id: 12 }, { tag_id: 3590 }],
      },
      { first_name: "no id" },
      { contact_id: "78", first_name: "Omar", last_name: "Demo-08", tags: [] },
    ],
  },
};

describe("Make's contact shapes (docs/49 D9, D11)", () => {
  it("reads the contact list at body.contact_list.data, skipping rows without a contact id", () => {
    expect(parseContactList(LIST)).toEqual([
      { contactId: 77, firstName: "Layla", lastName: "Demo-07", tagIds: [12, 3590] },
      { contactId: 78, firstName: "Omar", lastName: "Demo-08", tagIds: [] },
    ]);
    expect(parseContactList({ data: LIST })).toHaveLength(2);
    expect(parseContactList({ contact_list: {} })).toEqual([]);
    expect(parseContactList("nonsense")).toEqual([]);
  });

  it("adds a tag once, keeping the contact's own tags (Make: existing + ', ' + id, else id)", () => {
    expect(mergeTags([12, 34], 3590)).toEqual([12, 34, 3590]);
    expect(mergeTags([], 3590)).toEqual([3590]);
    expect(mergeTags([3590, 12, 12], 3590)).toEqual([3590, 12]);
  });

  it("splits a name into first and last word as Make's contacts/add does", () => {
    expect(firstLastWord("Layla Ahmed Demo-07")).toEqual({ first: "Layla", last: "Demo-07" });
    expect(firstLastWord("Layla")).toEqual({ first: "Layla", last: "Layla" });
    expect(firstLastWord("  ")).toEqual({ first: "", last: "" });
    expect(contactFullName({ full_name: "", first_name: "Layla", last_name: "Demo-07" })).toBe(
      "Layla Demo-07",
    );
  });

  it("recognises Sanoflow's invalid channel answer", () => {
    expect(answerSaysInvalidChannel(INVALID)).toBe(true);
    expect(answerSaysInvalidChannel({ error: { message: "invalid channel details" } })).toBe(true);
    expect(answerSaysInvalidChannel({ error: "Bad Request", message: "Template not found" })).toBe(
      false,
    );
  });

  it("reads the queueing context and ignores anything else", () => {
    expect(readOutboundContext({ context: { kind: "appointment_reminder" } })).toEqual({
      kind: "appointment_reminder",
    });
    expect(
      readOutboundContext({ context: { kind: "recall", programme: "birthday", live: true } }),
    ).toEqual({ kind: "recall", programme: "birthday", live: true });
    expect(
      readOutboundContext({ context: { kind: "recall", programme: "birthday", live: "yes" } }),
    ).toEqual({ kind: "recall", programme: "birthday", live: false });
    expect(readOutboundContext({ context: { kind: "recall", programme: "dental" } })).toBeNull();
    expect(readOutboundContext({ send: {} })).toBeNull();
    expect(readOutboundContext(null)).toBeNull();
  });

  it("re-creates the contact only for a reminder refused with invalid channel details, never after an ambiguous answer", () => {
    const reminder = { kind: "appointment_reminder" } as const;
    expect(shouldRecoverInvalidChannel(reminder, { invalidChannel: true, ambiguous: false })).toBe(
      true,
    );
    expect(shouldRecoverInvalidChannel(reminder, { invalidChannel: false, ambiguous: false })).toBe(
      false,
    );
    expect(shouldRecoverInvalidChannel(reminder, { invalidChannel: true, ambiguous: true })).toBe(
      false,
    );
    expect(
      shouldRecoverInvalidChannel(
        { kind: "recall", programme: "birthday", live: true },
        { invalidChannel: true, ambiguous: false },
      ),
    ).toBe(false);
    expect(shouldRecoverInvalidChannel(null, { invalidChannel: true, ambiguous: false })).toBe(
      false,
    );
  });

  it("tags only after Live recall sends with tagging on", () => {
    const on = { tagContacts: true };
    expect(shouldTagAfterSend({ kind: "recall", programme: "chronic_90d", live: true }, on)).toBe(
      true,
    );
    expect(shouldTagAfterSend({ kind: "recall", programme: "chronic_90d", live: false }, on)).toBe(
      false,
    );
    expect(
      shouldTagAfterSend(
        { kind: "recall", programme: "birthday", live: true },
        { tagContacts: false },
      ),
    ).toBe(false);
    expect(shouldTagAfterSend({ kind: "appointment_reminder" }, on)).toBe(false);
  });

  it("plans Make's edits: birthday adds 3590 and writes Pulse's names; chronic adds 4654 and label 1800, names unchanged", () => {
    const ids = readSanoflowConfig({});
    const found = parseContactList(LIST);
    const pulse = { first_name: "Mona", last_name: "Demo-09" };
    expect(planContactEdits("birthday", found.slice(0, 1), pulse, ids)).toEqual([
      { contactId: 77, firstName: "Mona", lastName: "Demo-09", tags: [12, 3590] },
    ]);
    expect(
      planContactEdits("birthday", found.slice(1), { first_name: " ", last_name: null }, ids),
    ).toEqual([{ contactId: 78, firstName: "Omar", lastName: "Demo-08", tags: [3590] }]);
    expect(planContactEdits("chronic_90d", found, pulse, ids)).toEqual([
      {
        contactId: 77,
        firstName: "Layla",
        lastName: "Demo-07",
        tags: [12, 3590, 4654],
        label: 1800,
      },
      { contactId: 78, firstName: "Omar", lastName: "Demo-08", tags: [4654], label: 1800 },
    ]);
  });

  it("reads the tagging settings with Make's ids as defaults", () => {
    expect(readSanoflowConfig({})).toMatchObject({
      tagContacts: true,
      birthdayTagId: 3590,
      chronicTagId: 4654,
      chronicLabelId: 1800,
    });
    expect(
      readSanoflowConfig({ tag_contacts: "off", birthday_tag_id: 11, chronic_tag_id: "x" }),
    ).toMatchObject({ tagContacts: false, birthdayTagId: 11, chronicTagId: 4654 });
  });

  it("reads a new contact's id from the add answer", () => {
    expect(readAddedContactId({ contact_id: 99 })).toBe(99);
    expect(readAddedContactId({ data: { id: "100" } })).toBe(100);
    expect(readAddedContactId({ status: true })).toBeNull();
  });
});

describe("Sanoflow contacts API on the shared client", () => {
  it("a send refused with invalid channel details is a definite failure flagged invalidChannel", async () => {
    const { c } = client([{ status: 400, json: INVALID }]);
    const r = await c.sendTemplate({ templateId: 11885, phone: "447700900123", values: ["Layla"] });
    expect(r).toMatchObject({
      ok: false,
      code: "http_400",
      invalidChannel: true,
      ambiguous: false,
    });
  });

  it("lists by phone or contact id with GET (retried after a timeout, being read-only)", async () => {
    const { c, calls } = client(["timeout", { status: 200, json: LIST }]);
    const r = await c.contactsList({ phone: "447700900123" });
    expect(r.ok && r.value.map((x) => x.contactId)).toEqual([77, 78]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(`${SANOFLOW_CONTACTS_URL}?phone=447700900123`);
    expect(calls[0]!.init.method).toBe("GET");
    const byId = client([{ status: 200, json: LIST }]);
    await byId.c.contactsList({ contactId: 77 });
    expect(byId.calls[0]!.url).toBe(`${SANOFLOW_CONTACTS_URL}?contact_id=77`);
  });

  it("adds a contact on v1 with Make's body; a timeout is ambiguous and not repeated", async () => {
    const ok = client([{ status: 200, json: { status: true, contact_id: 501 } }]);
    const r = await ok.c.contactsAdd({
      firstName: "Layla",
      lastName: "Demo-07",
      phone: "447700900123",
    });
    expect(r).toEqual({ ok: true, value: { contactId: 501 } });
    expect(ok.calls[0]!.url).toBe(SANOFLOW_CONTACTS_ADD_URL);
    expect(JSON.parse(String(ok.calls[0]!.init.body))).toEqual({
      first_name: "Layla",
      last_name: "Demo-07",
      phone: "447700900123",
    });
    const slow = client(["timeout", { status: 200, json: { status: true } }]);
    const s = await slow.c.contactsAdd({ firstName: "L", lastName: "D", phone: "447700900123" });
    expect(s).toEqual({ ok: false, code: "timeout", ambiguous: true });
    expect(slow.calls).toHaveLength(1);
  });

  it("edits tags and label on v1.1 with Make's body", async () => {
    const { c, calls, records } = client([{ status: 200, json: { status: true } }]);
    const r = await c.contactsEdit({
      contactId: 77,
      firstName: "Layla",
      lastName: "Demo-07",
      tags: [12, 4654],
      label: 1800,
    });
    expect(r).toEqual({ ok: true, value: null });
    expect(calls[0]!.url).toBe(SANOFLOW_CONTACTS_EDIT_URL);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      contact_id: 77,
      first_name: "Layla",
      last_name: "Demo-07",
      label: 1800,
      tags: [12, 4654],
    });
    // The call log never carries a URL, body or name.
    expect(JSON.stringify(records)).not.toMatch(/Layla|4654|contact_id/);
  });

  it("an edit Sanoflow refuses is a plain failure", async () => {
    const { c } = client([{ status: 200, json: { status: false } }]);
    expect(await c.contactsEdit({ contactId: 1, firstName: "", lastName: "", tags: [1] })).toEqual({
      ok: false,
      code: "rejected",
      ambiguous: false,
    });
  });
});
