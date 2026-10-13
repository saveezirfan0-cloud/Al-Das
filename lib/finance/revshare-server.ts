import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";

/**
 * Server side of the revenue share (20F): the service-role reads behind the pages. Callers have run can() on a
 * finance.revshare.* key first. Doctor ids, amounts and people's names (who verified, approved, paid) only.
 */

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** "Firstname Lastname" per profile id ("A former member" when the profile is gone). */
export async function profileNames(
  admin: AdminClient,
  ids: Array<string | null | undefined>,
): Promise<(id: string | null | undefined) => string | null> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  const { data } = wanted.length
    ? await admin.from("profiles").select("id, first_name, last_name").in("id", wanted)
    : { data: [] as Array<{ id: string; first_name: string | null; last_name: string | null }> };
  const map = new Map(
    (data ?? []).map((p) => [
      p.id,
      `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || "A member",
    ]),
  );
  return (id) => (id ? (map.get(id) ?? "A former member") : null);
}

/** Deep equality of two JSON values, numbers compared by value and object keys in any order (as jsonb = does). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" || typeof b === "number")
    return Number(a) === Number(b) && typeof a === typeof b;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return (
    ka.length === kb.length &&
    ka.every((k) => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

/** The month's inputs as the database holds them now. */
export async function loadInputs(
  admin: AdminClient,
  orgId: string,
  month: string,
): Promise<unknown> {
  const { data, error } = await admin.rpc("fin_revshare_inputs", {
    p_org_id: orgId,
    p_month: `${month}-01`,
  });
  if (error) throw new Error("Could not read the revenue share inputs.");
  return data;
}

export type Liability = {
  total: number;
  runs: Array<{ month: string; status: string; doctors: number; unpaid: number }>;
};

export async function loadLiability(admin: AdminClient, orgId: string): Promise<Liability> {
  const { data } = await admin.rpc("fin_revshare_liability", { p_org_id: orgId });
  const j = (data ?? {}) as Partial<Liability>;
  return {
    total: Number(j.total ?? 0),
    runs: (j.runs ?? []).map((r) => ({
      month: String(r.month),
      status: String(r.status),
      doctors: Number(r.doctors),
      unpaid: Number(r.unpaid),
    })),
  };
}

/** Service categories Finance has in reference data, plus Unmapped (what a category rate may name). */
export async function knownCategories(admin: AdminClient, orgId: string): Promise<string[]> {
  const { data } = await admin
    .from("fin_ref_services")
    .select("service_category")
    .eq("org_id", orgId)
    .limit(5000);
  const set = new Set<string>(["Unmapped"]);
  for (const r of data ?? []) {
    const c = (r.service_category ?? "").trim();
    if (c) set.add(c);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}
