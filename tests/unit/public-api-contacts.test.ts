import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearListeners, on } from "@/lib/events/emit";
import { createContactSchema, serializeContact, updateContact, updateContactSchema, upsertContact } from "@/lib/public-api/contacts";
import type { AdminClient } from "@/lib/supabase/admin";

import { createFakeAdmin } from "../helpers/fake-admin";

const unique = { contacts: [["org_id", "phone_e164"], ["org_id", "external_id"]] };
const defaults = { contacts: () => ({ first_name: "", last_name: "", email: null, gender: null, nationality: null, country: null, language: null, dob: null, external_id: null, promotions_opt_in: false, stop_marketing: false, source: "manual", deleted_at: null, merged_into_id: null }) };

function setup(seed: Record<string, Record<string, unknown>[]> = {}) {
  const admin = createFakeAdmin(seed, { unique, defaults });
  return { admin, as: admin as unknown as AdminClient };
}

describe("contact schemas", () => {
  it("requires a phone and rejects unknown fields (no mass assignment)", () => {
    expect(createContactSchema.safeParse({}).success).toBe(false);
    expect(createContactSchema.safeParse({ phone: "+971501234567" }).success).toBe(true);
    expect(createContactSchema.safeParse({ phone: "+971501234567", owner_id: "x" }).success).toBe(false);
    expect(createContactSchema.safeParse({ phone: "+971501234567", wa_bsuid: "x", custom: {} }).success).toBe(false);
  });

  it("validates fields and normalises the email", () => {
    const ok = createContactSchema.safeParse({ phone: "+971501234567", email: " Pat@Example.TEST ", dob: "1990-02-28", gender: "female", country: "AE" });
    expect(ok.success && ok.data.email).toBe("pat@example.test");
    expect(createContactSchema.safeParse({ phone: "1", dob: "1990-02-30" }).success).toBe(false);
    expect(createContactSchema.safeParse({ phone: "1", dob: "28/02/1990" }).success).toBe(false);
    expect(createContactSchema.safeParse({ phone: "1", gender: "x" }).success).toBe(false);
    expect(createContactSchema.safeParse({ phone: "1", country: "uae" }).success).toBe(false);
    expect(createContactSchema.safeParse({ phone: "1", email: "nope" }).success).toBe(false);
  });

  it("lets the API record an opt-out but never lift one", () => {
    expect(createContactSchema.safeParse({ phone: "1", stop_marketing: true }).success).toBe(true);
    expect(createContactSchema.safeParse({ phone: "1", stop_marketing: false }).success).toBe(false);
    expect(updateContactSchema.safeParse({ stop_marketing: false }).success).toBe(false);
  });

  it("requires at least one field to update", () => {
    expect(updateContactSchema.safeParse({}).success).toBe(false);
    expect(updateContactSchema.safeParse({ first_name: "Amal" }).success).toBe(true);
  });

  it("serialises only the public fields", () => {
    const out = serializeContact({
      id: "c1", org_id: "o1", first_name: "Amal", last_name: "K", full_name: "Amal K", phone_e164: "+971501234567", wa_bsuid: "BSUID_SECRET", email: null, gender: null,
      nationality: null, country: null, language: null, dob: null, label: null, owner_id: "u1", assignee_id: null, source: "api", external_id: null, promotions_opt_in: false,
      stop_marketing: false, custom: { insurance: "x" }, last_interaction_at: null, created_by: null, merged_into_id: null, deleted_at: null, created_at: "t", updated_at: "t",
    } as never);
    expect(Object.keys(out)).not.toEqual(expect.arrayContaining(["wa_bsuid", "owner_id", "custom", "org_id"]));
    expect(out).toMatchObject({ id: "c1", phone: "+971501234567", first_name: "Amal" });
  });
});

describe("upsertContact", () => {
  let events: Array<[string, unknown]>;
  beforeEach(() => {
    events = [];
    clearListeners();
    on("*", (e) => void events.push([e.name, e.payload]));
  });
  afterEach(() => clearListeners());

  it("creates a contact with the phone normalised to E.164 and source 'api'", async () => {
    const { admin, as } = setup();
    const r = await upsertContact(as, "org1", { phone: "050 123 4567", first_name: "Amal" });
    expect(r.ok && r.created).toBe(true);
    expect(admin._rows("contacts")).toHaveLength(1);
    expect(admin._rows("contacts")[0]).toMatchObject({ org_id: "org1", phone_e164: "+971501234567", first_name: "Amal", source: "api" });
    expect(events.map((e) => e[0])).toEqual(["contact.created"]);
  });

  it("matches by phone instead of creating a duplicate, updating only the fields sent", async () => {
    const { admin, as } = setup({ contacts: [{ id: "c1", org_id: "org1", phone_e164: "+971501234567", first_name: "Amal", last_name: "Khan", email: "keep@example.test", deleted_at: null }] });
    const r = await upsertContact(as, "org1", { phone: "+971 50 123 4567", first_name: "Amal M." });
    expect(r.ok && r.created).toBe(false);
    expect(admin._rows("contacts")).toHaveLength(1);
    expect(admin._rows("contacts")[0]).toMatchObject({ first_name: "Amal M.", last_name: "Khan", email: "keep@example.test" });
    expect(events).toEqual([]);
  });

  it("returns the existing contact untouched when nothing but the phone is sent", async () => {
    const { admin, as } = setup({ contacts: [{ id: "c1", org_id: "org1", phone_e164: "+971501234567", first_name: "Amal", deleted_at: null }] });
    const r = await upsertContact(as, "org1", { phone: "+971501234567" });
    expect(r.ok && r.created).toBe(false);
    expect(admin._calls.filter((c) => c.table === "contacts" && c.op === "update")).toHaveLength(0);
  });

  it("matches a contact by an alternate number instead of creating a duplicate", async () => {
    const { admin, as } = setup({
      contacts: [{ id: "c1", org_id: "org1", phone_e164: "+971501111111", first_name: "Amal", deleted_at: null }],
      contact_phones: [{ id: "p1", org_id: "org1", contact_id: "c1", phone_e164: "+971502222222" }],
    });
    const r = await upsertContact(as, "org1", { phone: "+971502222222", first_name: "Amal M." });
    expect(r.ok && r.created).toBe(false);
    expect(admin._rows("contacts")).toHaveLength(1);
    expect(admin._rows("contacts")[0]).toMatchObject({ id: "c1", first_name: "Amal M.", phone_e164: "+971501111111" });
  });

  it("ignores alternate numbers of deleted or merged contacts and of other orgs", async () => {
    const { admin, as } = setup({
      contacts: [
        { id: "c1", org_id: "org1", phone_e164: null, deleted_at: "2026-01-01", merged_into_id: "c9" },
        { id: "cB", org_id: "orgB", phone_e164: "+971509999999", deleted_at: null },
      ],
      contact_phones: [
        { id: "p1", org_id: "org1", contact_id: "c1", phone_e164: "+971502222222" },
        { id: "p2", org_id: "orgB", contact_id: "cB", phone_e164: "+971502222222" },
      ],
    });
    const r = await upsertContact(as, "org1", { phone: "+971502222222" });
    expect(r.ok && r.created).toBe(true);
    expect(admin._rows("contacts")).toHaveLength(3);
  });

  it("does not see another org's contact with the same phone", async () => {
    const { admin, as } = setup({ contacts: [{ id: "c9", org_id: "orgB", phone_e164: "+971501234567", first_name: "B", deleted_at: null }] });
    const r = await upsertContact(as, "org1", { phone: "+971501234567", first_name: "A" });
    expect(r.ok && r.created).toBe(true);
    expect(admin._rows("contacts")).toHaveLength(2);
    expect(admin._rows("contacts").find((c) => c.id === "c9")?.first_name).toBe("B");
  });

  it("rejects an invalid phone with 422", async () => {
    const { as } = setup();
    const r = await upsertContact(as, "org1", { phone: "12" });
    expect(r).toMatchObject({ ok: false, status: 422, code: "invalid_phone" });
  });

  it("answers 409 when the external id belongs to another contact", async () => {
    const { as } = setup({ contacts: [{ id: "c1", org_id: "org1", phone_e164: "+971501111111", external_id: "PIN-1", deleted_at: null }] });
    const r = await upsertContact(as, "org1", { phone: "+971502222222", external_id: "PIN-1" });
    expect(r).toMatchObject({ ok: false, status: 409, code: "conflict" });
  });

  it("emits contact.stop_marketing once when an opt-out is recorded", async () => {
    const { as } = setup({ contacts: [{ id: "c1", org_id: "org1", phone_e164: "+971501234567", stop_marketing: false, deleted_at: null }] });
    await upsertContact(as, "org1", { phone: "+971501234567", stop_marketing: true });
    await upsertContact(as, "org1", { phone: "+971501234567", stop_marketing: true });
    expect(events.filter((e) => e[0] === "contact.stop_marketing")).toHaveLength(1);
  });
});

describe("updateContact", () => {
  beforeEach(() => clearListeners());

  const seed = {
    contacts: [
      { id: "c1", org_id: "org1", phone_e164: "+971501111111", first_name: "A", deleted_at: null },
      { id: "c2", org_id: "org1", phone_e164: "+971502222222", first_name: "B", deleted_at: null },
      { id: "c3", org_id: "orgB", phone_e164: "+971503333333", first_name: "Other", deleted_at: null },
    ],
  };

  it("404s for a contact in another org or a deleted one", async () => {
    const { as } = setup({ contacts: [...seed.contacts, { id: "c4", org_id: "org1", phone_e164: "+971504444444", deleted_at: "2026-01-01" }] });
    expect(await updateContact(as, "org1", "c3", { first_name: "x" })).toMatchObject({ ok: false, status: 404 });
    expect(await updateContact(as, "org1", "c4", { first_name: "x" })).toMatchObject({ ok: false, status: 404 });
  });

  it("normalises a new phone and refuses one another contact owns", async () => {
    const { admin, as } = setup(seed);
    const ok = await updateContact(as, "org1", "c1", { phone: "050 555 5555" });
    expect(ok.ok).toBe(true);
    expect(admin._rows("contacts").find((c) => c.id === "c1")?.phone_e164).toBe("+971505555555");
    expect(await updateContact(as, "org1", "c1", { phone: "+971502222222" })).toMatchObject({ ok: false, status: 409 });
    expect(await updateContact(as, "org1", "c1", { phone: "x" })).toMatchObject({ ok: false, status: 422, code: "invalid_phone" });
  });
});

void vi;
