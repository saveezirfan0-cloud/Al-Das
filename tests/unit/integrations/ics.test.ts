import { describe, expect, it } from "vitest";

import {
  escapeText,
  eventUid,
  feedWindow,
  foldLine,
  formatUtc,
  icsStatus,
  renderCalendar,
  sequenceOf,
  type IcsAppointment,
} from "@/lib/integrations/calendar/ics";
import {
  feedUrl,
  generateFeedToken,
  hashFeedToken,
  parseFeedToken,
} from "@/lib/integrations/calendar/token";

const APPT: IcsAppointment = {
  id: "11111111-2222-3333-4444-555555555555",
  startsAt: "2026-10-20T06:30:00+00:00",
  endsAt: "2026-10-20T07:00:00+00:00",
  status: "confirmed",
  updatedAt: "2026-10-18T09:15:30+00:00",
  locationName: "Al Das Clinic, Jumeirah",
};

/** Unfolds, then splits into content lines (a minimal RFC 5545 reader for assertions). */
function lines(ics: string): string[] {
  expect(ics.endsWith("\r\n")).toBe(true);
  expect(ics.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/); // only CRLF line breaks anywhere
  return ics
    .replace(/\r\n[ \t]/g, "")
    .split("\r\n")
    .filter(Boolean);
}

describe("text escaping and folding", () => {
  it("escapes backslash, semicolon, comma and newlines, and drops control characters", () => {
    expect(escapeText("a,b;c\\d\ne")).toBe("a\\,b\;c\\\\d\\ne");
    expect(escapeText("x\u0000y\u0007z")).toBe("xyz");
  });

  it("folds at 75 octets without splitting a multi-byte character", () => {
    const long = "SUMMARY:" + "ع".repeat(80); // Arabic: 2 octets per character
    const folded = foldLine(long);
    for (const part of folded.split("\r\n"))
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    expect(
      folded
        .split("\r\n")
        .slice(1)
        .every((p) => p.startsWith(" ")),
    ).toBe(true);
    expect(folded.replace(/\r\n /g, "")).toBe(long);
    expect(foldLine("short")).toBe("short");
  });

  it("folds an ASCII line exactly at 75", () => {
    const f = foldLine("X".repeat(200));
    const parts = f.split("\r\n");
    expect(parts[0]).toHaveLength(75);
    expect(parts[1]).toHaveLength(75); // 74 chars plus the leading space
    expect(f.replace(/\r\n /g, "")).toBe("X".repeat(200));
  });
});

describe("time, ids and sequence", () => {
  it("writes UTC basic format", () => {
    expect(formatUtc(new Date("2026-01-02T03:04:05Z"))).toBe("20260102T030405Z");
  });

  it("derives a stable uid from the appointment id only", () => {
    expect(eventUid(APPT.id)).toBe(eventUid(APPT.id));
    expect(eventUid(APPT.id)).not.toBe(eventUid("another"));
    expect(eventUid(APPT.id)).toMatch(/^[0-9a-f]{32}@pulse\.calendar$/);
    expect(eventUid(APPT.id)).not.toContain(APPT.id);
  });

  it("raises the sequence with every edit", () => {
    const a = sequenceOf("2026-10-18T09:15:00Z");
    const b = sequenceOf("2026-10-18T09:16:00Z");
    expect(b).toBe(a + 1);
    expect(a).toBeLessThan(2 ** 31);
    expect(sequenceOf("nonsense")).toBe(0);
  });

  it("maps statuses", () => {
    expect(icsStatus("cancelled")).toBe("CANCELLED");
    expect(icsStatus("awaiting")).toBe("TENTATIVE");
    expect(icsStatus("confirmed")).toBe("CONFIRMED");
    expect(icsStatus("no_show")).toBe("CONFIRMED");
  });

  it("covers the last 7 days and the next 60", () => {
    const { from, to } = feedWindow(new Date("2026-10-18T00:00:00Z"));
    expect(from.toISOString()).toBe("2026-10-11T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-12-17T00:00:00.000Z");
  });
});

describe("calendar", () => {
  const ics = renderCalendar({ name: "Dr Amal, Jumeirah", appointments: [APPT] });
  const l = lines(ics);

  it("is a well-formed VCALENDAR with the required properties", () => {
    expect(l[0]).toBe("BEGIN:VCALENDAR");
    expect(l.at(-1)).toBe("END:VCALENDAR");
    expect(l).toContain("VERSION:2.0");
    expect(l.some((x) => x.startsWith("PRODID:"))).toBe(true);
    expect(l).toContain("METHOD:PUBLISH");
    expect(l).toContain("X-WR-CALNAME:Dr Amal\\, Jumeirah");
    const begin = l.filter((x) => x === "BEGIN:VEVENT").length;
    const end = l.filter((x) => x === "END:VEVENT").length;
    expect(begin).toBe(1);
    expect(end).toBe(1);
  });

  it("gives each event the required VEVENT properties in UTC", () => {
    expect(l).toContain(`UID:${eventUid(APPT.id)}`);
    expect(l).toContain("DTSTAMP:20261018T091530Z");
    expect(l).toContain("DTSTART:20261020T063000Z");
    expect(l).toContain("DTEND:20261020T070000Z");
    expect(l).toContain("SUMMARY:Appointment");
    expect(l).toContain("LOCATION:Al Das Clinic\\, Jumeirah");
    expect(l).toContain("STATUS:CONFIRMED");
    expect(l.some((x) => /^SEQUENCE:\d+$/.test(x))).toBe(true);
    expect(l).toContain("CLASS:PRIVATE");
  });

  it("contains ONLY the whitelisted properties, whatever the caller passes in", () => {
    const hostile = {
      ...APPT,
      patientName: "SECRETNAME",
      phone: "+971500000000",
      notes: "SECRETNOTE",
      serviceName: "SECRETSERVICE",
      number: 4242,
    };
    const out = renderCalendar({ name: "Feed", appointments: [hostile as IcsAppointment] });
    for (const s of ["SECRETNAME", "971500000000", "SECRETNOTE", "SECRETSERVICE", "4242"])
      expect(out).not.toContain(s);
    const props = new Set(lines(out).map((x) => x.split(/[:;]/)[0]));
    expect([...props].sort()).toEqual(
      [
        "BEGIN",
        "CALSCALE",
        "CLASS",
        "DTEND",
        "DTSTAMP",
        "DTSTART",
        "END",
        "LOCATION",
        "METHOD",
        "PRODID",
        "REFRESH-INTERVAL",
        "SEQUENCE",
        "STATUS",
        "SUMMARY",
        "TRANSP",
        "UID",
        "VERSION",
        "X-PUBLISHED-TTL",
        "X-WR-CALNAME",
      ].sort(),
    );
  });

  it("keeps a cancelled appointment as STATUS:CANCELLED with a higher sequence so apps remove it", () => {
    const edited = { ...APPT, status: "cancelled", updatedAt: "2026-10-18T10:00:00Z" };
    const before = renderCalendar({ name: "F", appointments: [APPT] });
    const after = lines(renderCalendar({ name: "F", appointments: [edited] }));
    expect(after).toContain("STATUS:CANCELLED");
    expect(after).toContain("TRANSP:TRANSPARENT");
    expect(after).toContain(`UID:${eventUid(APPT.id)}`);
    const seq = (src: string[]) => Number(src.find((x) => x.startsWith("SEQUENCE:"))!.slice(9));
    expect(seq(after)).toBeGreaterThan(seq(lines(before)));
  });

  it("omits LOCATION when there is none and is deterministic and sorted", () => {
    const a = { ...APPT, id: "a", locationName: null };
    const b = {
      ...APPT,
      id: "b",
      startsAt: "2026-10-19T06:30:00Z",
      endsAt: "2026-10-19T07:00:00Z",
    };
    const one = renderCalendar({ name: "F", appointments: [a, b] });
    const two = renderCalendar({ name: "F", appointments: [b, a] });
    expect(one).toBe(two);
    expect(lines(one).filter((x) => x.startsWith("LOCATION")).length).toBe(1);
    expect(one.indexOf(eventUid("b"))).toBeLessThan(one.indexOf(eventUid("a")));
  });

  it("folds long lines and survives an Arabic calendar name", () => {
    const out = renderCalendar({
      name: "مواعيد الدكتورة أمل في عيادة الداس للرعاية الصحية الشاملة والمتكاملة",
      appointments: [],
    });
    for (const line of out.split("\r\n"))
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(lines(out).join("")).toContain("مواعيد");
  });
});

describe("feed tokens", () => {
  it("are long, unique, prefixed and stored only as a hash", () => {
    const a = generateFeedToken();
    const b = generateFeedToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^pcf_[A-Za-z0-9_-]{43}$/);
    expect(hashFeedToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashFeedToken(a)).toBe(hashFeedToken(a));
    expect(hashFeedToken(a)).not.toContain(a);
  });

  it("parse from a URL segment with or without .ics, and nothing else", () => {
    const t = generateFeedToken();
    expect(parseFeedToken(t)).toBe(t);
    expect(parseFeedToken(`${t}.ics`)).toBe(t);
    expect(parseFeedToken(`${t}x`)).toBeNull();
    expect(parseFeedToken("pcf_short")).toBeNull();
    expect(parseFeedToken(`../${t}`)).toBeNull();
    expect(parseFeedToken(`${t}.ICS`)).toBeNull();
    expect(feedUrl("https://pulse.test/", t)).toBe(`https://pulse.test/api/calendar/${t}.ics`);
  });
});
