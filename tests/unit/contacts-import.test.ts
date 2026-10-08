import { describe, expect, it } from "vitest";

import {
  coerceCustomObject,
  coerceCustomValue,
  formatCustomValue,
  parseLooseDate,
  type CustomFieldDef,
} from "@/lib/contacts/custom-values";
import { contactsToCsv } from "@/lib/contacts/export";
import { guessMapping, normalizeGender, parseBool, splitList } from "@/lib/contacts/fields";
import { prepareImport } from "@/lib/contacts/import";
import { diffForMerge, resolveMergeFields } from "@/lib/contacts/merge";
import { combineFilters, viewFilter } from "@/lib/contacts/views";
import { parseCsv } from "@/lib/csv";
import { cond, and } from "@/lib/filters/ast";

const plan: CustomFieldDef = {
  key: "plan",
  label: "Insurance plan",
  type: "select",
  options: [
    { value: "axa", label: "AXA" },
    { value: "mednet", label: "Mednet" },
  ],
  required: false,
};
const visits: CustomFieldDef = {
  key: "visits",
  label: "Visits",
  type: "number",
  options: [],
  required: false,
};
const interests: CustomFieldDef = {
  key: "interests",
  label: "Interests",
  type: "multi_select",
  options: [
    { value: "derma", label: "Dermatology" },
    { value: "dental", label: "Dental" },
  ],
  required: false,
};

describe("header mapping", () => {
  it("guesses standard fields and custom fields from headers", () => {
    const m = guessMapping(
      [
        "First Name",
        "Last Name",
        "Mobile Number",
        "E-mail",
        "DOB",
        "Insurance plan",
        "Whatever",
        "Tags",
      ],
      [plan],
    );
    expect(m).toEqual({
      "First Name": "first_name",
      "Last Name": "last_name",
      "Mobile Number": "phone",
      "E-mail": "email",
      DOB: "dob",
      "Insurance plan": "custom.plan",
      Whatever: null,
      Tags: "tags",
    });
  });

  it("does not map the same field twice", () => {
    const m = guessMapping(["Phone", "Mobile"]);
    expect(m).toEqual({ Phone: "phone", Mobile: null });
  });

  it("normalises helpers", () => {
    expect(normalizeGender("F")).toBe("female");
    expect(normalizeGender("Male")).toBe("male");
    expect(normalizeGender("zzz")).toBeNull();
    expect(parseBool("Yes")).toBe(true);
    expect(parseBool("opted out")).toBe(false);
    expect(parseBool("maybe")).toBeNull();
    expect(splitList("a; b,c|a")).toEqual(["a", "b", "c"]);
  });
});

describe("prepareImport", () => {
  const csv = parseCsv(
    [
      "Name,Phone,Email,Gender,DOB,Insurance plan,Tags,Alternate phones",
      "Amina Test,0501234567,Amina@Example.test,F,10/10/1990,AXA,vip;derma,050 222 2222",
      "Bilal Test,+971501234567,,M,1985-02-10,,,",
      "No Phone,,x@example.test,,,,,",
      "Bad Phone,12,,,,,,",
      "Bad Plan,0503333333,,,,Gold,,",
      ",,,,,,,",
      "Bad Date,0504444444,,,31/02/2020,,,",
    ].join("\n"),
  );
  const mapping = guessMapping(csv.headers, [plan]);
  const { rows, summary } = prepareImport(csv.headers, csv.rows, { mapping, customFields: [plan] });

  it("summarises ok / invalid / duplicate rows", () => {
    expect(summary).toEqual({ total: 7, ok: 1, invalid: 5, duplicates: 1 });
  });

  it("normalises a good row", () => {
    const r = rows[0];
    expect(r.status).toBe("ok");
    expect(r.contact).toMatchObject({
      first_name: "Amina",
      last_name: "Test",
      phone_e164: "+971501234567",
      email: "amina@example.test",
      gender: "female",
      dob: "1990-10-10",
      custom: { plan: "axa" },
      tags: ["vip", "derma"],
      alternate_phones: ["+971502222222"],
    });
  });

  it("flags duplicates within the file by phone (first wins)", () => {
    expect(rows[1].status).toBe("duplicate");
    expect(rows[1].duplicateOf).toBe(1);
  });

  it("reports validation errors per row", () => {
    expect(rows[2].errors).toEqual(["Missing phone number"]);
    expect(rows[3].errors).toEqual(["Invalid phone number"]);
    expect(rows[4].errors).toEqual(['Insurance plan: "Gold" is not an option']);
    expect(rows[5].errors).toContain("Row is empty");
    expect(rows[6].errors).toEqual(["Invalid date of birth"]);
  });

  it("can import rows without phones when allowed", () => {
    const { summary: s } = prepareImport(csv.headers, csv.rows, {
      mapping,
      customFields: [plan],
      requirePhone: false,
    });
    expect(s.ok).toBe(2);
  });
});

describe("custom field values", () => {
  it("coerces by type and fails on bad values", () => {
    expect(coerceCustomValue(plan, "Mednet")).toEqual({ ok: true, value: "mednet" });
    expect(coerceCustomValue(plan, "")).toEqual({ ok: true, value: null });
    expect(coerceCustomValue({ ...plan, required: true }, "")).toEqual({
      ok: false,
      error: "Insurance plan is required",
    });
    expect(coerceCustomValue(visits, "1,200")).toEqual({ ok: true, value: 1200 });
    expect(coerceCustomValue(visits, "x")).toMatchObject({ ok: false });
    expect(coerceCustomValue(interests, "Dental; derma")).toEqual({
      ok: true,
      value: ["dental", "derma"],
    });
    expect(coerceCustomValue({ ...visits, type: "boolean" }, "no")).toEqual({
      ok: true,
      value: false,
    });
    expect(coerceCustomValue({ ...visits, type: "date" }, "5/1/2026")).toEqual({
      ok: true,
      value: "2026-01-05",
    });
    expect(coerceCustomValue({ ...visits, type: "email" }, "A@B.co")).toEqual({
      ok: true,
      value: "a@b.co",
    });
    expect(coerceCustomValue({ ...visits, type: "url" }, "example.com")).toEqual({
      ok: true,
      value: "https://example.com/",
    });
    expect(parseLooseDate("2020-02-30")).toBeNull();
  });

  it("validates whole objects and drops unknown keys", () => {
    expect(coerceCustomObject([plan, visits], { plan: "axa", visits: "3", junk: 1 })).toEqual({
      ok: true,
      value: { plan: "axa", visits: 3 },
    });
    expect(coerceCustomObject([plan, visits], { plan: "nope" })).toEqual({
      ok: false,
      errors: { plan: 'Insurance plan: "nope" is not an option' },
    });
    expect(coerceCustomObject([plan, visits], { visits: 2 }, { partial: true })).toEqual({
      ok: true,
      value: { visits: 2 },
    });
    expect(formatCustomValue(interests, ["derma", "x"])).toBe("Dermatology, x");
    expect(formatCustomValue({ ...visits, type: "boolean" }, true)).toBe("Yes");
  });
});

describe("merge resolution", () => {
  const primary = {
    first_name: "Amina",
    last_name: "",
    email: "a@example.test",
    dob: "1990-01-01",
  };
  const secondary = {
    first_name: "Aminah",
    last_name: "Test",
    email: "a@example.test",
    phone_e164: "+971500000002",
  };

  it("detects conflicts only where both sides differ", () => {
    const diffs = diffForMerge(primary, secondary);
    expect(diffs.find((d) => d.field === "first_name")?.conflict).toBe(true);
    expect(diffs.find((d) => d.field === "last_name")?.conflict).toBe(false);
    expect(diffs.find((d) => d.field === "email")?.conflict).toBe(false);
  });

  it("resolves with primary defaults, picks and blank-filling", () => {
    expect(resolveMergeFields(primary, secondary)).toEqual({
      first_name: "Amina",
      last_name: "Test",
      phone_e164: "+971500000002",
      email: "a@example.test",
      dob: "1990-01-01",
    });
    expect(resolveMergeFields(primary, secondary, { first_name: "secondary" }).first_name).toBe(
      "Aminah",
    );
  });
});

describe("views and export", () => {
  it("builds view filters and combines them", () => {
    expect(viewFilter("recent7", "u").include.children).toEqual([
      cond("last_interaction_at", "within_last", 7),
    ]);
    expect(viewFilter("mentions", "u1").include.children).toEqual([
      cond("mentioned_user", "eq", "u1"),
    ]);
    const combined = combineFilters(
      viewFilter("stale30", "u"),
      {
        include: and(cond("gender", "eq", "female")),
        exclude: and(cond("stop_marketing", "is_true")),
      },
      null,
    );
    expect(combined.include.children).toHaveLength(2);
    expect(combined.exclude?.children).toHaveLength(1);
    expect(combineFilters(null, undefined).include.children).toEqual([]);
  });

  it("exports CSV with custom fields and safe cells", () => {
    const csv = contactsToCsv(
      [
        {
          id: "1",
          first_name: "=Amina",
          last_name: "Test",
          phone_e164: "+971500000001",
          email: null,
          gender: "female",
          nationality: null,
          country: "AE",
          language: null,
          dob: "1990-10-10",
          label: null,
          source: "manual",
          external_id: null,
          promotions_opt_in: true,
          stop_marketing: false,
          tags: ["vip", "derma"],
          custom: { plan: "axa" },
          last_interaction_at: null,
          created_at: "2026-10-01T00:00:00Z",
        },
      ],
      [plan],
    );
    const parsed = parseCsv(csv);
    expect(parsed.headers).toContain("Insurance plan");
    const row = Object.fromEntries(parsed.headers.map((h, i) => [h, parsed.rows[0][i]]));
    expect(row["First name"]).toBe("'=Amina");
    expect(row["Tags"]).toBe("vip; derma");
    expect(row["Promotions opt-in"]).toBe("yes");
    expect(row["Insurance plan"]).toBe("AXA");
  });
});
