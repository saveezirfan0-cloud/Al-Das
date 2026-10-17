import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  mergeResults,
  parseRecordQuery,
  phoneHint,
  RECORD_SEARCH_LIMIT,
  RECORD_SEARCH_MAX_LENGTH,
  recordHref,
} from "@/lib/shell/record-search";

// Synthetic values only: reserved test numbers (+44 7700 900xxx) and made-up names.

describe("parseRecordQuery", () => {
  it("ignores queries shorter than two characters", () => {
    expect(parseRecordQuery("")).toBeNull();
    expect(parseRecordQuery(" a ")).toBeNull();
    expect(parseRecordQuery("ab")).not.toBeNull();
  });

  it("collapses spaces, caps the length and escapes LIKE wildcards", () => {
    const q = parseRecordQuery("  Layla   Demo_07 %  ")!;
    expect(q.text).toBe("Layla Demo_07 %");
    expect(q.like).toBe("%Layla Demo\\_07 \\%%");
    expect(parseRecordQuery("x".repeat(500))!.text).toHaveLength(RECORD_SEARCH_MAX_LENGTH);
    expect(parseRecordQuery("a\\b")!.like).toBe("%a\\\\b%");
  });

  it("normalises a full phone number to E.164, local UAE numbers too", () => {
    expect(parseRecordQuery("+44 7700 900123")!.e164).toBe("+447700900123");
    expect(parseRecordQuery("0044 7700 900123")!.e164).toBe("+447700900123");
    expect(parseRecordQuery("050 123 4567")!.e164).toBe("+971501234567");
    expect(parseRecordQuery("(050) 123-4567")!.digits).toBe("0501234567");
  });

  it("keeps partial digits for a contains search, and no E.164 for a fragment", () => {
    const q = parseRecordQuery("4567")!;
    expect(q.digits).toBe("4567");
    expect(q.e164).toBeNull();
    expect(parseRecordQuery("45")!.digits).toBeNull();
    // a name is not a phone, even with a digit in it
    expect(parseRecordQuery("Demo 07")!.digits).toBeNull();
  });

  it("reads an enquiry number with or without #", () => {
    expect(parseRecordQuery("#123")!.enquiryNumber).toBe(123);
    expect(parseRecordQuery("123")!.enquiryNumber).toBe(123);
    expect(parseRecordQuery("12a")!.enquiryNumber).toBeNull();
    expect(parseRecordQuery("1234567890")!.enquiryNumber).toBeNull();
  });
});

describe("results", () => {
  it("open a patient's full record, and the other kinds' drawers through their list page's deep link", () => {
    expect(recordHref("contact", "c-1")).toBe("/contacts/c-1");
    expect(recordHref("contact", "a&b")).toBe("/contacts/a%26b");
    expect(recordHref("enquiry", "e-1")).toBe("/enquiries?enquiry=e-1");
    expect(recordHref("task", "t-1")).toBe("/tasks?task=t-1");
    expect(recordHref("task", "a&b")).toBe("/tasks?task=a%26b");
  });

  it("merge in first-seen order without repeats, five at most", () => {
    const a = [{ id: "1" }, { id: "2" }];
    const b = [{ id: "2" }, { id: "3" }, { id: "4" }, { id: "5" }, { id: "6" }];
    expect(mergeResults([a, b]).map((r) => r.id)).toEqual(["1", "2", "3", "4", "5"]);
    expect(mergeResults([a, b])).toHaveLength(RECORD_SEARCH_LIMIT);
  });

  it("show only the last four digits of a phone", () => {
    expect(phoneHint("+447700900123")).toBe("ends 0123");
    expect(phoneHint(null)).toBeUndefined();
  });
});

describe("record search server rules (source checks)", () => {
  const src = readFileSync(join(process.cwd(), "lib/shell/record-search-server.ts"), "utf8");
  const action = readFileSync(join(process.cwd(), "components/shell/search-actions.ts"), "utf8");

  it("checks each kind's own view key", () => {
    for (const key of ["contacts.view", "enquiries.view", "tasks.view"]) {
      expect(src, key).toContain(`can(member, "${key}")`);
      expect(action, key).toContain(`"${key}"`);
    }
  });

  it("filters soft-deleted rows on every table it reads", () => {
    const reads = src.match(/\.from\("(contacts|enquiries|tasks)"\)/g) ?? [];
    expect(reads.length).toBe(3);
    expect((src.match(/\.is\("deleted_at", null\)/g) ?? []).length).toBe(3);
  });

  it("applies the enquiry visibility and branch rules and rate limits each person", () => {
    expect(src).toContain("visibleEnquiryIds(");
    expect(src).toContain("withBranchFilter(");
    expect(action).toContain("RATE_RULES.recordSearchPerUser");
  });

  it("never logs the query text", () => {
    for (const s of [src, action]) {
      for (const line of s.split("\n").filter((l) => l.includes("console."))) {
        expect(line).not.toMatch(/\bq\b|query|text|like|digits|e164/);
      }
    }
    expect(src).toContain('action: "search"');
  });
});
