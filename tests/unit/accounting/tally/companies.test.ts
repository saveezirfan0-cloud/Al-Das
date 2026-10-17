/**
 * W7: which Tally company belongs to which entity (lib/accounting/tally/companies.ts), and which entity a Tally XML file
 * is imported into. The same scenarios run against app.acc_tally_company in tests/db/accounting-tally-companies.test.ts.
 * Synthetic data only.
 */
import { describe, expect, it } from "vitest";

import {
  pickImportEntity,
  resolveCompanies,
  sameCompany,
  type CompanyEntity,
} from "@/lib/accounting/tally/companies";

import scenarios from "./fixtures/company-scenarios.synthetic.json";

type Scenario = {
  name: string;
  fallback: string | null;
  entities: Array<{
    key: string;
    is_default: boolean;
    active: boolean;
    tally_company: string | null;
  }>;
};
const asEntities = (s: Scenario): CompanyEntity[] => s.entities.map((e) => ({ ...e, id: e.key }));

describe("resolveCompanies", () => {
  for (const s of scenarios.resolve as unknown as Array<
    Scenario & { expect: Record<string, string | null> }
  >)
    it(s.name, () => {
      const got = resolveCompanies(asEntities(s), s.fallback);
      expect(Object.fromEntries(got)).toEqual(s.expect);
    });

  it("treats a blank own company as none and compares names without case or outer spaces", () => {
    const e = (id: string, def: boolean, c: string | null): CompanyEntity => ({
      id,
      is_default: def,
      active: true,
      tally_company: c,
    });
    expect(resolveCompanies([e("a", true, "   ")], " Demo A ").get("a")).toBe("Demo A");
    expect(sameCompany(" Demo A", "demo a ")).toBe(true);
    expect(sameCompany("Demo A", "Demo B")).toBe(false);
  });
});

describe("pickImportEntity", () => {
  for (const s of scenarios.importPick as unknown as Array<
    Scenario & {
      fileCompany: string | null;
      expect: { ok: boolean; key?: string; code?: string };
    }
  >)
    it(s.name, () => {
      const got = pickImportEntity(s.fileCompany, asEntities(s), s.fallback);
      expect(got.ok).toBe(s.expect.ok);
      if (got.ok) expect(got.entityId).toBe(s.expect.key);
      else expect(got.code).toBe(s.expect.code);
    });

  it("has no entity to import into without a default entity", () => {
    expect(pickImportEntity(null, [], null)).toEqual({ ok: false, code: "no_default_entity" });
  });
});
