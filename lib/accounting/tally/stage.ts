import type { StagedRow, TallyPlan } from "./plan";

/**
 * The acc_tally_staged rows of a plan (pure), in the order the commit works them: masters first (groups, cost centres,
 * ledgers, parents first), then vouchers. The server inserts them in batches; the database tests insert the same rows.
 */
export type StagedInsert = {
  org_id: string;
  import_id: string;
  seq: number;
  kind: StagedRow["kind"];
  guid: string | null;
  alter_id: number | null;
  payload: Record<string, unknown>;
};

export function stagedRows(
  orgId: string,
  importId: string,
  plan: Pick<TallyPlan, "masters" | "vouchers">,
): StagedInsert[] {
  return [...plan.masters, ...plan.vouchers].map((r) => ({
    org_id: orgId,
    import_id: importId,
    seq: r.seq,
    kind: r.kind,
    guid: r.guid,
    alter_id: r.alter_id,
    payload: r.payload,
  }));
}

/** Batches of `size` (the commit posts vouchers in batches too). */
export function chunk<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}
