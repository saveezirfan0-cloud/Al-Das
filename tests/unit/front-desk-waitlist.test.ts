import { describe, expect, it } from "vitest";

import {
  chooseOfferChannel,
  classifyOfferButton,
  classifyOfferReply,
  entryMatchesSlot,
  offerExpiry,
  rankEntries,
  renderOfferOutcomeText,
  renderOfferText,
  serviceForEntry,
  slotOfferable,
  type FreedSlot,
  type ServiceFit,
  type WaitlistEntry,
} from "@/lib/front-desk/waitlist";

const tz = "Asia/Dubai";
const slot: FreedSlot = {
  specialist_id: "dr-a",
  location_id: "loc-1",
  service_id: "svc-consult",
  starts_at: "2026-10-15T06:00:00Z", // 10:00 Dubai
  ends_at: "2026-10-15T06:30:00Z",
};
const fits: ServiceFit[] = [
  { service_id: "svc-consult", duration_min: 30, offered_by_specialist: true },
  { service_id: "svc-long", duration_min: 60, offered_by_specialist: true },
  { service_id: "svc-other", duration_min: 15, offered_by_specialist: false },
];
const entry = (over: Partial<WaitlistEntry> = {}): WaitlistEntry => ({
  id: "e1",
  contact_id: "c1",
  specialist_id: null,
  service_id: null,
  location_id: null,
  not_after: null,
  created_at: "2026-10-10T08:00:00Z",
  status: "waiting",
  ...over,
});

describe("which waiting patients fit a freed slot", () => {
  it("matches an entry for the same doctor, any doctor, or the same service", () => {
    expect(entryMatchesSlot(entry({ specialist_id: "dr-a" }), slot, fits, tz)).toBe(true);
    expect(entryMatchesSlot(entry({ specialist_id: "dr-b" }), slot, fits, tz)).toBe(false);
    expect(entryMatchesSlot(entry({ service_id: "svc-consult" }), slot, fits, tz)).toBe(true);
    expect(entryMatchesSlot(entry({ location_id: "loc-2" }), slot, fits, tz)).toBe(false);
  });

  it("refuses a service that is too long for the slot or not offered by that doctor", () => {
    expect(serviceForEntry({ service_id: "svc-long" }, slot, fits)).toBeNull();
    expect(serviceForEntry({ service_id: "svc-other" }, slot, fits)).toBeNull();
    expect(serviceForEntry({ service_id: "unknown" }, slot, fits)).toBeNull();
    expect(serviceForEntry({ service_id: null }, slot, fits)).toBe("svc-consult");
  });

  it("does not offer a slot with an unknown service to an entry that has none", () => {
    expect(serviceForEntry({ service_id: null }, { ...slot, service_id: null }, fits)).toBeNull();
  });

  it("stops at the entry's last acceptable date in clinic time", () => {
    expect(
      entryMatchesSlot(entry({ specialist_id: "dr-a", not_after: "2026-10-15" }), slot, fits, tz),
    ).toBe(true);
    expect(
      entryMatchesSlot(entry({ specialist_id: "dr-a", not_after: "2026-10-14" }), slot, fits, tz),
    ).toBe(false);
    // 22:00 UTC is already the next day in Dubai
    const late = { ...slot, starts_at: "2026-10-15T21:00:00Z", ends_at: "2026-10-15T21:30:00Z" };
    expect(
      entryMatchesSlot(entry({ specialist_id: "dr-a", not_after: "2026-10-15" }), late, fits, tz),
    ).toBe(false);
  });

  it("ignores entries that are not waiting", () => {
    expect(
      entryMatchesSlot(entry({ specialist_id: "dr-a", status: "booked" }), slot, fits, tz),
    ).toBe(false);
  });
});

describe("offer order", () => {
  it("is first come first served, one question per person, skipping anyone already asked", () => {
    const list = [
      entry({ id: "late", contact_id: "c3", created_at: "2026-10-12T08:00:00Z" }),
      entry({ id: "first", contact_id: "c1", created_at: "2026-10-10T08:00:00Z" }),
      entry({
        id: "dup",
        contact_id: "c1",
        created_at: "2026-10-11T08:00:00Z",
        specialist_id: "dr-a",
      }),
      entry({ id: "asked", contact_id: "c2", created_at: "2026-10-10T09:00:00Z" }),
    ];
    const ranked = rankEntries(list, slot, fits, tz, new Set(["asked"])).map((e) => e.id);
    expect(ranked).toEqual(["first", "late"]);
  });

  it("breaks a tie in favour of the entry that named this doctor", () => {
    const same = "2026-10-10T08:00:00Z";
    const ranked = rankEntries(
      [
        entry({ id: "any", contact_id: "c1", created_at: same }),
        entry({ id: "named", contact_id: "c2", created_at: same, specialist_id: "dr-a" }),
      ],
      slot,
      fits,
      tz,
    ).map((e) => e.id);
    expect(ranked).toEqual(["named", "any"]);
  });
});

describe("timing and channel", () => {
  const now = new Date("2026-10-15T04:00:00Z");
  it("will not offer a slot that is too close or past", () => {
    expect(slotOfferable(slot, now, 60)).toBe(true);
    expect(slotOfferable(slot, new Date("2026-10-15T05:30:00Z"), 60)).toBe(false);
    expect(slotOfferable(slot, new Date("2026-10-15T07:00:00Z"), 0)).toBe(false);
  });

  it("expires the offer after the TTL, never after the slot starts", () => {
    expect(offerExpiry(now, 15, new Date(slot.starts_at)).toISOString()).toBe(
      "2026-10-15T04:15:00.000Z",
    );
    expect(
      offerExpiry(new Date("2026-10-15T05:55:00Z"), 15, new Date(slot.starts_at)).toISOString(),
    ).toBe(new Date(slot.starts_at).toISOString());
  });

  it("sends free text inside the 24-hour window, the template outside it, and nothing without a template", () => {
    const inside = "2026-10-15T01:00:00Z";
    const outside = "2026-10-13T01:00:00Z";
    expect(chooseOfferChannel(inside, true, now)).toEqual({ kind: "text" });
    expect(chooseOfferChannel(inside, false, now)).toEqual({ kind: "text" });
    expect(chooseOfferChannel(outside, true, now)).toEqual({ kind: "template" });
    expect(chooseOfferChannel(null, true, now)).toEqual({ kind: "template" });
    expect(chooseOfferChannel(outside, false, now)).toEqual({
      kind: "blocked",
      reason: "no_template",
    });
  });
});

describe("reading the answer", () => {
  it("understands yes and no in English and Arabic", () => {
    for (const t of ["YES", " yes! ", "Yes please", "ok", "نعم", "ايوه", "تمام"])
      expect(classifyOfferReply(t), t).toBe("yes");
    for (const t of ["No", "no thanks", "NOPE", "لا", "لا شكرا"])
      expect(classifyOfferReply(t), t).toBe("no");
  });

  it("treats anything else, or anything long, as unknown", () => {
    for (const t of [
      "maybe",
      "what time?",
      "",
      null,
      undefined,
      "yes but I need to ask my husband first, can you hold it until tomorrow please",
    ])
      expect(classifyOfferReply(t as string), String(t)).toBe("unknown");
  });

  it("reads the offer template's buttons", () => {
    expect(classifyOfferButton({ title: "Yes, book it" })).toBe("yes");
    expect(classifyOfferButton({ id: "decline", title: "Not now" })).toBe("no");
    expect(classifyOfferButton({ title: "Remind me later" })).toBe("unknown");
  });

  it("writes the offer without naming the patient", () => {
    const en = renderOfferText({
      startsAt: new Date(slot.starts_at),
      timezone: tz,
      specialist: "Dr Example",
      location: "Main clinic",
      expiresInMin: 15,
    });
    expect(en).toContain("Dr Example");
    expect(en).toContain("Thursday 15 October at 10:00 AM");
    expect(en).toContain("15 minutes");
    expect(en).toMatch(/YES/);
    const ar = renderOfferText({
      startsAt: new Date(slot.starts_at),
      timezone: tz,
      specialist: "Dr Example",
      location: null,
      expiresInMin: 10,
      language: "ar",
    });
    expect(ar).toMatch(/[؀-ۿ]/);
    expect(renderOfferOutcomeText("taken")).toMatch(/taken/);
    expect(renderOfferOutcomeText("booked", "ar")).toMatch(/[؀-ۿ]/);
  });
});
