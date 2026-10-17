/**
 * Which Tally company belongs to which accounting entity (W7). Pure; the database (`app.acc_tally_company`, migration
 * 20261222000300) is the rule the bridge runs on, and tests/db/accounting-tally-companies.test.ts checks this file
 * against it on the same scenarios.
 *
 *  - An entity's own `tally_company`, else (the DEFAULT entity only) the Tally bridge integration's company setting.
 *  - An inactive entity has none.
 *  - Two entities that would share a name (case-insensitive) have none: they must never feed one company.
 *  - An entity with no company is not bridged: nothing is sent for it and nothing is pulled.
 */

export type CompanyEntity = {
  id: string;
  is_default: boolean;
  active: boolean;
  tally_company: string | null;
};

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
};

export const sameCompany = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** entity id -> its Tally company (null: none, or ambiguous). `fallback` is the integration's company setting. */
export function resolveCompanies(
  entities: readonly CompanyEntity[],
  fallback: string | null,
): Map<string, string | null> {
  const fb = clean(fallback);
  const named = entities
    .filter((e) => e.active)
    .map((e) => ({ id: e.id, name: clean(e.tally_company) ?? (e.is_default ? fb : null) }));
  const out = new Map<string, string | null>();
  for (const e of entities) {
    const mine = named.find((n) => n.id === e.id)?.name ?? null;
    const clash =
      mine !== null &&
      named.some((n) => n.id !== e.id && n.name !== null && sameCompany(n.name, mine));
    out.set(e.id, mine !== null && !clash ? mine : null);
  }
  return out;
}

export type ImportEntityChoice =
  { ok: true; entityId: string } | { ok: false; code: "company_not_linked" | "no_default_entity" };

/**
 * The entity a Tally XML file (22I) is imported into, from the company named inside it.
 *  - It names an entity's Tally company: that entity.
 *  - No company in the file, or nobody set an entity company yet (the single-company installation): the default
 *    entity, as before.
 *  - Otherwise the file is from a company Pulse does not know: refused, never guessed into the default entity.
 */
export function pickImportEntity(
  fileCompany: string | null,
  entities: readonly CompanyEntity[],
  fallback: string | null,
): ImportEntityChoice {
  const def = entities.find((e) => e.is_default && e.active);
  const company = clean(fileCompany);
  if (company) {
    const names = resolveCompanies(entities, fallback);
    const hits = entities.filter((e) => {
      const n = names.get(e.id);
      return n != null && sameCompany(n, company);
    });
    if (hits.length === 1) return { ok: true, entityId: hits[0].id };
    // the opt-in to several companies is an entity with its own company; until then a file always went to the default entity
    const optedIn = entities.some((e) => e.active && clean(e.tally_company) !== null);
    if (optedIn) return { ok: false, code: "company_not_linked" };
  }
  return def ? { ok: true, entityId: def.id } : { ok: false, code: "no_default_entity" };
}
