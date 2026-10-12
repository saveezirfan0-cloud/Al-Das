import { describe, expect, it } from "vitest";

import {
  activeFilterCount,
  claimProgress,
  day,
  filterProblem,
  pageQuery,
  parseInvoiceFilters,
  safe,
} from "@/lib/finance/invoice-list";

describe("safe", () => {
  it("strips PostgREST grammar characters and clamps length", () => {
    expect(safe("  a(b),c%d*e\\f ")).toBe("a b  c d e f");
    expect(safe(undefined)).toBe("");
    expect(safe("x".repeat(200))).toHaveLength(80);
  });
});

describe("day", () => {
  it("accepts real dates only", () => {
    expect(day("2026-02-28")).toBe("2026-02-28");
    expect(day("2026-02-31")).toBe("");
    expect(day("09/10/2026")).toBe("");
    expect(day(undefined)).toBe("");
  });
});

describe("parseInvoiceFilters", () => {
  it("defaults and reads each field", () => {
    expect(parseInvoiceFilters({})).toEqual({
      q: "",
      from: "",
      to: "",
      branch: "",
      doctor: "",
      type: "",
      page: 1,
    });
    expect(
      parseInvoiceFilters({ q: " INV-1 ", branch: "dxb", from: "2026-09-01", page: "3" }),
    ).toMatchObject({ q: "INV-1", branch: "dxb", from: "2026-09-01", page: 3 });
  });
  it("falls back to page 1 for junk", () => {
    expect(parseInvoiceFilters({ page: "-2" }).page).toBe(1);
    expect(parseInvoiceFilters({ page: "abc" }).page).toBe(1);
    expect(parseInvoiceFilters({ page: "2.9" }).page).toBe(2);
  });
});

describe("filter helpers", () => {
  it("flags a reversed date range", () => {
    expect(filterProblem(parseInvoiceFilters({ from: "2026-09-20", to: "2026-09-01" }))).toMatch(
      /after/,
    );
    expect(filterProblem(parseInvoiceFilters({ from: "2026-09-01", to: "2026-09-01" }))).toBeNull();
    expect(filterProblem(parseInvoiceFilters({ from: "2026-09-01" }))).toBeNull();
  });
  it("counts only filters, not the page", () => {
    expect(activeFilterCount(parseInvoiceFilters({ page: "4" }))).toBe(0);
    expect(activeFilterCount(parseInvoiceFilters({ q: "a", doctor: "b", page: "4" }))).toBe(2);
  });
  it("builds page links that keep filters and drop empties", () => {
    const f = parseInvoiceFilters({ doctor: "Dr Test", type: "Insurance" });
    expect(pageQuery(parseInvoiceFilters({}), 1)).toBe("");
    expect(pageQuery(f, 1)).toBe("?doctor=Dr+Test&type=Insurance");
    expect(pageQuery(f, 3)).toBe("?doctor=Dr+Test&type=Insurance&page=3");
  });
});

describe("claimProgress", () => {
  const row = (
    claim_count: number,
    claimed: number | null,
    remitted: number | null,
    rejected: number | null,
  ) => ({
    claim_count,
    claimed,
    remitted,
    rejected,
  });
  it("has no claim without claim rows", () => {
    expect(claimProgress(row(0, null, null, null))).toBe("none");
    expect(
      claimProgress({ claim_count: null, claimed: null, remitted: null, rejected: null }),
    ).toBe("none");
  });
  it("is awaiting while nothing has come back", () => {
    expect(claimProgress(row(1, 500, 0, 0))).toBe("awaiting");
    expect(claimProgress(row(1, 500, null, null))).toBe("awaiting");
  });
  it("is settled once remitted covers the claim, to within rounding", () => {
    expect(claimProgress(row(2, 500, 500, 0))).toBe("settled");
    expect(claimProgress(row(2, 500, 499.996, 0))).toBe("settled");
  });
  it("is part paid when some, but not all, has been remitted", () => {
    expect(claimProgress(row(1, 500, 300, 0))).toBe("partial");
    expect(claimProgress(row(1, 500, 300, 200))).toBe("partial");
  });
  it("is rejected when money was refused and none remitted", () => {
    expect(claimProgress(row(1, 500, 0, 500))).toBe("rejected");
    expect(claimProgress(row(1, 500, null, 120))).toBe("rejected");
  });
  it("reads numeric strings, as PostgREST returns numerics", () => {
    expect(
      claimProgress({ claim_count: "1", claimed: "500.00", remitted: "500.00", rejected: "0.00" }),
    ).toBe("settled");
  });
});
