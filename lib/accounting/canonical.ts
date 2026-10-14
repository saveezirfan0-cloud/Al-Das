/**
 * The journal's canonical content (pure). journalCanonical() builds exactly the text acc_journal_canonical() builds in SQL
 * (migration 20261108000100); a database test proves they agree. The checker's approval is bound to its sha256, and the
 * same hash is frozen on the posted journal. The number is not part of it (it is allocated at posting). Text fields
 * escape backslash, newline, carriage return and "|".
 */

export type CanonicalLine = {
  lineNo: number;
  accountId: string;
  debit: number | string;
  credit: number | string;
  taxCodeId?: string | null;
  branchCode?: string | null;
  department?: string | null;
  doctorId?: string | null;
  payerId?: string | null;
  supplierId?: string | null;
  costCentreId?: string | null;
  partyKind?: string | null;
  partyId?: string | null;
  currency?: string | null;
  fxRate?: number | string | null;
  amountFx?: number | string | null;
  description?: string | null;
};

export type CanonicalJournal = {
  orgId: string;
  entityId: string;
  voucherType: string;
  journalDate: string; // YYYY-MM-DD
  narration: string;
  sourceKind?: string | null;
  sourceId?: string | null;
  sourceVersion?: number | null;
  reversalOf?: string | null;
  isAdjustment?: boolean;
  autoReverseOn?: string | null;
  lines: readonly CanonicalLine[];
};

export const esc = (v: string) =>
  v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\|/g, "\\|");

const opt = (v: string | null | undefined) => (v === null || v === undefined ? "-" : esc(v));
const id = (v: string | null | undefined) => (v ? v.toLowerCase() : "-");
const fixed = (v: number | string, dp: number) => Number(v).toFixed(dp);
const optFixed = (v: number | string | null | undefined, dp: number) =>
  v === null || v === undefined || v === "" ? "-" : fixed(v, dp);

export function journalCanonical(j: CanonicalJournal): string {
  const lines = [...j.lines]
    .sort((a, b) => a.lineNo - b.lineNo)
    .map((l) =>
      [
        "L",
        String(l.lineNo),
        l.accountId.toLowerCase(),
        fixed(l.debit, 2),
        fixed(l.credit, 2),
        id(l.taxCodeId),
        opt(l.branchCode),
        opt(l.department),
        opt(l.doctorId),
        opt(l.payerId),
        id(l.supplierId),
        id(l.costCentreId),
        l.partyKind ?? "-",
        opt(l.partyId),
        l.currency ?? "-",
        optFixed(l.fxRate, 8),
        optFixed(l.amountFx, 2),
        opt(l.description),
      ].join("|"),
    )
    .join("\n");
  return [
    "pulse-journal-v1",
    `org:${j.orgId.toLowerCase()}`,
    `entity:${j.entityId.toLowerCase()}`,
    `type:${j.voucherType}`,
    `date:${j.journalDate}`,
    `narration:${esc(j.narration)}`,
    `source:${j.sourceKind ?? "-"}/${opt(j.sourceId)}/${j.sourceVersion ?? "-"}`,
    `reversal_of:${id(j.reversalOf)}`,
    `adjustment:${j.isAdjustment ? "yes" : "no"}`,
    `auto_reverse_on:${j.autoReverseOn ?? "-"}`,
    `lines:${j.lines.length}`,
    lines,
  ].join("\n");
}
