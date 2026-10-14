/**
 * One doctor, one identity: the pure link suggestions between diary doctors, the finance reference and the Unite
 * report, and the page helpers around them. Synthetic names and ids only.
 */
import { describe, expect, it } from "vitest";

import { doctorParam } from "@/lib/finance/doctor-performance";
import { normaliseDoctorKey } from "@/lib/finance/unite-report-mapping";
import {
  financeDoctorLabel,
  licenceKey,
  performanceHref,
  suggestDoctorLinks,
  type LinkDoctor,
} from "@/lib/organisation/doctor-links";

const doc = (id: string, name: string, extra: Partial<LinkDoctor> = {}): LinkDoctor => ({
  id,
  name,
  licenceNumber: null,
  dhaId: null,
  reportDoctorKey: null,
  ...extra,
});

describe("suggestDoctorLinks: finance reference", () => {
  it("matches the licence number to the DHA id, ignoring spaces and case", () => {
    const s = suggestDoctorLinks(
      [doc("a", "Dr. Layla Demo-01", { licenceNumber: " dha 0001 " })],
      [
        { dhaId: "DHA0001", name: "Someone Else" },
        { dhaId: "DHA0002", name: "Layla Demo-01" },
      ],
      [],
    );
    expect(s.get("a")!.finance).toEqual({ status: "match", value: "DHA0001", reason: "licence" });
  });

  it("falls back to the normalised name when the licence matches nobody", () => {
    const s = suggestDoctorLinks(
      [doc("a", "Dr.Layla  demo-01", { licenceNumber: "X-404" })],
      [{ dhaId: "D2", name: "dr layla Demo-01" }],
      [],
    );
    expect(s.get("a")!.finance).toEqual({ status: "match", value: "D2", reason: "name" });
  });

  it("never guesses between two finance doctors with the same name", () => {
    const s = suggestDoctorLinks(
      [doc("a", "Omar Demo-02")],
      [
        { dhaId: "D1", name: "Dr. Omar Demo-02" },
        { dhaId: "D2", name: "omar demo-02" },
      ],
      [],
    );
    expect(s.get("a")!.finance).toEqual({ status: "ambiguous", reason: "name" });
  });

  it("never guesses when two unlinked diary doctors share the name", () => {
    const s = suggestDoctorLinks(
      [doc("a", "Sara Demo-03"), doc("b", "Dr. Sara Demo-03")],
      [{ dhaId: "D1", name: "Sara Demo-03" }],
      [],
    );
    expect(s.get("a")!.finance.status).toBe("ambiguous");
    expect(s.get("b")!.finance.status).toBe("ambiguous");
  });

  it("lets a licence match win over another doctor's name match", () => {
    const s = suggestDoctorLinks(
      [doc("a", "Nadia Demo-04", { licenceNumber: "D1" }), doc("b", "Rami Demo-05")],
      [{ dhaId: "D1", name: "Rami Demo-05" }],
      [],
    );
    expect(s.get("a")!.finance).toEqual({ status: "match", value: "D1", reason: "licence" });
    expect(s.get("b")!.finance).toEqual({ status: "ambiguous", reason: "name" });
  });

  it("reports a candidate already linked to another doctor as taken", () => {
    const s = suggestDoctorLinks(
      [doc("a", "Huda Demo-06"), doc("b", "Someone Demo-07", { dhaId: "D1" })],
      [{ dhaId: "D1", name: "Huda Demo-06" }],
      [],
    );
    expect(s.get("a")!.finance).toEqual({ status: "taken", value: "D1", reason: "name" });
    expect(s.get("b")!.finance).toEqual({ status: "none" });
  });

  it("gives no suggestion without a match, a name or finance data", () => {
    const s = suggestDoctorLinks(
      [doc("a", "Ali Demo-08"), doc("b", "  ")],
      [{ dhaId: "D1", name: null }],
      [],
    );
    expect(s.get("a")!.finance).toEqual({ status: "none" });
    expect(s.get("b")!.finance).toEqual({ status: "none" });
  });
});

describe("suggestDoctorLinks: Unite report", () => {
  const report = [
    { key: normaliseDoctorKey("Dr. Latifa Demo-09"), name: "Dr. Latifa Demo-09" },
    { key: "(no doctor)", name: "(no doctor)" },
  ];

  it("uses the Unite report's own normaliser", () => {
    const s = suggestDoctorLinks([doc("a", "dr latifa  DEMO-09")], [], report);
    expect(s.get("a")!.report).toEqual({
      status: "match",
      value: "latifa demo-09",
      reason: "name",
    });
  });

  it("never offers the direct-sales bucket", () => {
    const s = suggestDoctorLinks([doc("a", "(no doctor)")], [], report);
    expect(s.get("a")!.report).toEqual({ status: "none" });
  });

  it("is ambiguous for two diary doctors with one report name, taken once linked", () => {
    const two = suggestDoctorLinks(
      [doc("a", "Latifa Demo-09"), doc("b", "Dr Latifa Demo-09")],
      [],
      report,
    );
    expect(two.get("a")!.report.status).toBe("ambiguous");
    const linked = suggestDoctorLinks(
      [doc("a", "Latifa Demo-09"), doc("b", "Other", { reportDoctorKey: "latifa demo-09" })],
      [],
      report,
    );
    expect(linked.get("a")!.report).toEqual({
      status: "taken",
      value: "latifa demo-09",
      reason: "name",
    });
    expect(linked.get("b")!.report).toEqual({ status: "none" });
  });
});

describe("doctor link helpers", () => {
  it("normalises licence keys", () => {
    expect(licenceKey(" ab 12 ")).toBe("AB12");
    expect(licenceKey(null)).toBe("");
  });

  it("labels finance doctors with the id", () => {
    expect(financeDoctorLabel({ dhaId: "D1", name: " Layla Demo-01 " })).toBe("Layla Demo-01 · D1");
    expect(financeDoctorLabel({ dhaId: "D1", name: null })).toBe("D1");
  });

  it("links the performance page to one doctor when the key is known", () => {
    expect(performanceHref("latifa demo-09")).toBe(
      "/finance/doctor-performance?doctor=latifa%20demo-09",
    );
    expect(performanceHref(null)).toBe("/finance/doctor-performance");
  });

  it("reads the performance page's doctor parameter", () => {
    expect(doctorParam(" latifa demo-09 ")).toBe("latifa demo-09");
    for (const bad of ["", "   ", undefined, null, ["a"], "x".repeat(201)])
      expect(doctorParam(bad as string | string[] | null | undefined)).toBeNull();
  });
});
