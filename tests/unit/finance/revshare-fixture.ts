/**
 * Turns the synthetic revenue-share fixture into what fin_revshare_inputs() returns, by the same rules (current lines of
 * invoices not deleted, transaction date inside the month, category from reference data or Unmapped, amounts in 2 dp).
 * The database test compares this with the SQL output (parity); the unit test feeds it to the calculator.
 */
import fixture from "./fixtures/revshare.synthetic.json";

type Inv = {
  no: string;
  doctor: string | null;
  date: string;
  lines: Array<[string, number]>;
  deleted?: boolean;
  superseded?: boolean;
};

export const FIXTURE = fixture;
export const ALL_INVOICES: Inv[] = [...(fixture.invoices as Inv[]), ...(fixture.noise as Inv[])];

const round2 = (n: number) => Math.round(n * 100) / 100;

export function revenueFromFixture(month = fixture.month) {
  const end = new Date(Date.parse(`${month}T00:00:00Z`));
  end.setUTCMonth(end.getUTCMonth() + 1);
  const last = end.toISOString().slice(0, 10);
  const cat = new Map(fixture.services.map(([item, c]) => [item, c]));
  const agg = new Map<
    string,
    { doctor: string | null; category: string; net: number; lines: number; inv: Set<string> }
  >();
  for (const i of ALL_INVOICES) {
    if (i.deleted || i.superseded || i.date < month || i.date >= last) continue;
    for (const [item, net] of i.lines) {
      const category = cat.get(item) ?? "Unmapped";
      const key = `${i.doctor ?? ""}|${category}`;
      const a = agg.get(key) ?? {
        doctor: i.doctor,
        category,
        net: 0,
        lines: 0,
        inv: new Set<string>(),
      };
      a.net += net;
      a.lines += 1;
      a.inv.add(i.no);
      agg.set(key, a);
    }
  }
  return [...agg.values()]
    .sort((a, b) =>
      a.doctor === b.doctor
        ? a.category < b.category
          ? -1
          : 1
        : a.doctor === null
          ? 1
          : b.doctor === null
            ? -1
            : a.doctor < b.doctor
              ? -1
              : 1,
    )
    .map((a) => ({
      doctor_dha_id: a.doctor,
      category: a.category,
      net: round2(a.net),
      lines: a.lines,
      invoices: a.inv.size,
    }));
}

/** A complete inputs object for the calculator (ids and hashes are placeholders). */
export function inputsFromFixture() {
  const ids = new Set<string>();
  for (const r of revenueFromFixture()) if (r.doctor_dha_id) ids.add(r.doctor_dha_id);
  for (const c of fixture.charges) ids.add(c.doctor);
  for (const s of fixture.schemes) ids.add(s.doctor);
  const names = new Map(fixture.doctors.map((d) => [d.dha_id, d.name]));
  return {
    month: fixture.month,
    doctor_basis: null,
    revenue: revenueFromFixture(),
    charges: fixture.charges.map((c, i) => ({
      id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`,
      doctor_dha_id: c.doctor,
      kind: c.kind,
      amount: c.amount,
      source: "manual",
      reference: c.reference,
    })),
    schemes: fixture.schemes.map((s, i) => ({
      doctor_dha_id: s.doctor,
      scheme_id: `00000000-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`,
      version: 1,
      effective_from: "2026-01-01",
      rule: s.rule,
      rule_hash: "f".repeat(64),
      verified_by: null,
      verified_at: null,
      approved_by: null,
      approved_at: null,
    })),
    doctors: [...ids].sort().map((id) => ({ dha_id: id, name: names.get(id) ?? null })),
  };
}
