import { describe, expect, it } from "vitest";

import { buildAppointmentTemplateValues } from "@/lib/appointments/reminders";
import {
  householdNameValues,
  resolveRecipient,
  type HouseholdContact,
} from "@/lib/household/addressing";
import {
  comparePerson,
  decidePhoneMatch,
  nameTokens,
  type PhoneCandidate,
} from "@/lib/household/shared-phone";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

const guardian: HouseholdContact = {
  id: "g",
  first_name: "Layla",
  last_name: "Example",
  phone_e164: "+971500000101",
  wa_bsuid: null,
};
const child: HouseholdContact = {
  id: "k",
  first_name: "Omar",
  last_name: "Example",
  phone_e164: null,
  wa_bsuid: null,
};

describe("reminder addressing for a household", () => {
  it("sends a dependant's reminder to the guardian's number", () => {
    const r = resolveRecipient(child, { guardian, reminders_to_guardian: true });
    expect(r).toMatchObject({ viaGuardian: true });
    expect(r?.recipient.id).toBe("g");
    expect(r?.recipient.phone_e164).toBe("+971500000101");
    expect(r?.patient.id).toBe("k");
  });

  it("sends an ordinary patient's reminder to the patient", () => {
    const r = resolveRecipient(guardian, null);
    expect(r?.viaGuardian).toBe(false);
    expect(r?.recipient.id).toBe("g");
  });

  it("honours 'reminders to guardian' switched off when the dependant has their own WhatsApp", () => {
    const adult = { ...child, phone_e164: "+971500000102" };
    const off = resolveRecipient(adult, { guardian, reminders_to_guardian: false });
    expect(off?.recipient.id).toBe("k");
    // ...but a dependant with nothing to receive on still goes through the guardian
    const none = resolveRecipient(child, { guardian, reminders_to_guardian: false });
    expect(none?.recipient.id).toBe("g");
  });

  it("returns nobody when neither has a way to be reached, so the failure is reported", () => {
    expect(
      resolveRecipient(child, {
        guardian: { ...guardian, phone_e164: null },
        reminders_to_guardian: true,
      }),
    ).toBeNull();
    expect(resolveRecipient(child, null)).toBeNull();
  });

  it("falls back to the patient's own number when the guardian has none", () => {
    const own = { ...child, phone_e164: "+971500000102" };
    const r = resolveRecipient(own, {
      guardian: { ...guardian, phone_e164: null },
      reminders_to_guardian: true,
    });
    expect(r?.recipient.id).toBe("k");
    expect(r?.viaGuardian).toBe(false);
  });

  it("names the patient in the guardian's greeting unless the template asks for the patient itself", () => {
    expect(
      householdNameValues({ patient: child, guardian, explicitPatientVariable: false }),
    ).toMatchObject({
      "contact.first_name": "Layla (for Omar)",
      "contact.name": "Layla Example (for Omar)",
      "patient.first_name": "Omar",
      "guardian.first_name": "Layla",
    });
    expect(
      householdNameValues({ patient: child, guardian, explicitPatientVariable: true }),
    ).toMatchObject({
      "contact.first_name": "Layla",
      "patient.name": "Omar Example",
    });
    // no guardian: nothing overrides contact.*
    expect(
      householdNameValues({ patient: child, guardian: null, explicitPatientVariable: false })[
        "contact.first_name"
      ],
    ).toBeUndefined();
  });

  const components: MetaTemplateComponent[] = [
    { type: "BODY", text: "Hello {{1}}, your appointment is {{2}} with {{3}}." },
  ];
  const ctx = {
    contact: { first_name: "Omar", last_name: "Example" },
    startsAt: new Date("2026-10-15T06:00:00Z"),
    timezone: "Asia/Dubai",
    specialist: "Dr Example",
    location: "Main clinic",
  };

  it("fills a standard reminder template so the guardian can see whose appointment it is", () => {
    const values = buildAppointmentTemplateValues(
      components,
      {},
      { ...ctx, guardian: { first_name: "Layla", last_name: "Example" } },
    );
    expect(values["body.1"]).toBe("Layla (for Omar)");
    expect(values["body.3"]).toBe("Dr Example");
  });

  it("uses the plain guardian name when the template maps patient.first_name itself", () => {
    const values = buildAppointmentTemplateValues(
      components,
      {
        "body.1": "guardian.first_name",
        "body.2": "appointment.datetime",
        "body.3": "patient.first_name",
      },
      { ...ctx, guardian: { first_name: "Layla", last_name: "Example" } },
    );
    expect(values["body.1"]).toBe("Layla");
    expect(values["body.3"]).toBe("Omar");
  });

  it("leaves a normal patient's reminder exactly as before", () => {
    const values = buildAppointmentTemplateValues(components, {}, ctx);
    expect(values["body.1"]).toBe("Omar");
  });
});

describe("matching on a phone number that a family shares", () => {
  const mother: PhoneCandidate = {
    id: "m",
    fullName: "Layla Example",
    dob: "1988-03-02",
    externalId: "PIN-1",
    dependant: false,
  };
  const son: PhoneCandidate = {
    id: "s",
    fullName: "Omar Example",
    dob: "2019-06-11",
    externalId: "PIN-2",
    dependant: true,
  };

  it("tokenises names across scripts and diacritics", () => {
    expect(nameTokens("  Layla  AL-Example ")).toEqual(["layla", "al", "example"]);
    expect(nameTokens("مُحَمَّد علي")).toEqual(["محمد", "علي"]);
  });

  it("compares by PIN first, then by date of birth and name", () => {
    expect(comparePerson({ externalId: "PIN-2" }, mother)).toBe("different");
    expect(comparePerson({ externalId: "PIN-1" }, mother)).toBe("same");
    expect(comparePerson({ fullName: "Omar Example", dob: "2019-06-11" }, mother)).toBe(
      "different",
    ); // dob differs
    expect(comparePerson({ fullName: "Layla Example", dob: "1988-03-02" }, mother)).toBe("same");
    expect(comparePerson({ fullName: "Layla Exmple", dob: "1988-03-02" }, mother)).toBe("unknown"); // spelling variant, same dob
  });

  it("never lets a bare phone number or a blank record count as evidence", () => {
    expect(comparePerson({}, mother)).toBe("unknown");
    expect(
      comparePerson(
        { fullName: "Omar" },
        { id: "x", fullName: null, dob: null, externalId: null, dependant: false },
      ),
    ).toBe("unknown");
  });

  it("does not trust a nickname on a bare WhatsApp contact to prove it is someone else", () => {
    const bare: PhoneCandidate = {
      id: "b",
      fullName: "Lulu",
      dob: null,
      externalId: null,
      dependant: false,
    };
    expect(comparePerson({ fullName: "Layla Example" }, bare)).toBe("unknown");
    expect(comparePerson({ fullName: "Layla Example" }, { ...bare, dob: "1988-03-02" })).toBe(
      "different",
    );
  });

  it("matches the dependant when the child arrives on the guardian's number", () => {
    const d = decidePhoneMatch(
      { externalId: "PIN-2", fullName: "Omar Example", dob: "2019-06-11" },
      [mother, son],
    );
    expect(d).toEqual({ kind: "match", id: "s", dependant: true });
  });

  it("matches the guardian when the guardian arrives", () => {
    const d = decidePhoneMatch({ fullName: "Layla Example", dob: "1988-03-02" }, [mother, son]);
    expect(d).toEqual({ kind: "match", id: "m", dependant: false });
  });

  it("flags a shared phone for a human when the child is not in Pulse yet, instead of matching the mother", () => {
    const d = decidePhoneMatch(
      { externalId: "PIN-9", fullName: "Noor Example", dob: "2021-01-05" },
      [mother, son],
    );
    expect(d).toEqual({ kind: "ambiguous", ids: ["m", "s"], reason: "shared_phone" });
  });

  it("behaves as before for a plain phone match (one holder, nothing contradicting it)", () => {
    expect(decidePhoneMatch({}, [mother])).toEqual({ kind: "match", id: "m", dependant: false });
    expect(decidePhoneMatch({ fullName: "Layla Example" }, [mother])).toEqual({
      kind: "match",
      id: "m",
      dependant: false,
    });
    expect(decidePhoneMatch({}, [])).toBeNull();
    // with no evidence two holders stay ambiguous, as the old code did
    expect(decidePhoneMatch({}, [mother, son])).toEqual({
      kind: "ambiguous",
      ids: ["m", "s"],
      reason: "multiple",
    });
  });
});
