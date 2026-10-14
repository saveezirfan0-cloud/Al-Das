import { cleanDescription, cleanNarration, type VoucherType } from "@/lib/accounting/journal";
import { TALLY_GROUPS } from "@/lib/accounting/tally-groups";

import { centsToAmount } from "./amounts";
import type { TallyEntry, TallyGroupRec, TallyLedgerRec, TallyParseResult } from "./parse";

/**
 * The dry run of a Tally import (pure): what the files hold, how Tally's groups and ledgers map onto Pulse's chart, the
 * opening trial balance and its zero-check, vouchers per month and type, and every refusal with its reason. It also
 * produces the sanitised rows the commit works from (acc_tally_staged): names, amounts, dates, codes and redacted
 * narrations only. Nothing here touches the database; the same plan always comes out of the same input.
 */

/** Tally's eight accounting voucher types and Pulse's names for them. A custom type maps through its PARENT chain. */
export const TALLY_BASE_TYPES: Readonly<Record<string, VoucherType>> = {
  payment: "payment",
  receipt: "receipt",
  contra: "contra",
  journal: "journal",
  sales: "sales",
  purchase: "purchase",
  "credit note": "credit_note",
  "debit note": "debit_note",
};

/** Tally's predefined "Profit & Loss A/c" ledger (accumulated profit) lands on Pulse's retained earnings account. */
export const TALLY_PL_LEDGER = "profit & loss a/c";

export type PlanAccount = {
  id: string;
  code: string;
  name: string;
  is_group: boolean;
  is_system: boolean;
  tally_guid: string | null;
  tally_group: string | null;
  control: string | null;
};
export type PlanContext = {
  accounts: readonly PlanAccount[];
  costCentres: ReadonlyArray<{ id: string; code: string; name: string }>;
  /** Live (posted) tally_import journals: the Tally GUID and the ALTERID it was posted at. */
  tallyJournals: ReadonlyArray<{ guid: string; version: number }>;
};

export type StagedRow = {
  seq: number;
  kind: "group" | "cost_centre" | "ledger" | "voucher";
  guid: string | null;
  alter_id: number | null;
  payload: Record<string, unknown>;
};

export type RefusalCode =
  | "no_guid"
  | "bad_date"
  | "no_type"
  | "bad_amount"
  | "sign_mismatch"
  | "entry_no_ledger"
  | "too_many_lines"
  | "type_unknown"
  | "ledger_unknown"
  | "unbalanced"
  | "too_few_lines"
  | "parent_unknown"
  | "name_clash"
  | "name_too_long"
  | "nature_unknown"
  | "no_retained_earnings";

export const REFUSAL_LABELS: Record<RefusalCode | BlockingCode, string> = {
  no_guid: "No GUID in the file (it cannot be matched on a re-import)",
  bad_date: "The date cannot be read",
  no_type: "No voucher type",
  bad_amount: "An amount cannot be read (or has more than two decimals)",
  sign_mismatch: "Debit / credit flag disagrees with the sign of the amount",
  entry_no_ledger: "A line has no ledger",
  too_many_lines: "More than 450 lines",
  type_unknown:
    "The voucher type is not one of Tally's eight accounting types (or its parent is not in the file)",
  ledger_unknown: "A ledger is neither in the file nor in Pulse",
  unbalanced: "Debits and credits differ",
  too_few_lines: "Fewer than two lines with an amount",
  parent_unknown: "The parent group is neither in the file nor in Pulse",
  name_clash: "A group and a ledger share this name",
  name_too_long: "The name is longer than 120 characters",
  nature_unknown: "A primary group without its nature flags",
  no_retained_earnings: "No retained earnings (control) account in Pulse",
  opening_unbalanced: "The opening balances do not net to zero",
  opening_invalid: "An opening balance cannot be read",
  opening_ledger_refused: "A ledger with an opening balance was refused",
  opening_date_needed: "Choose the opening date (the file has no vouchers to take it from)",
  opening_after_vouchers: "The opening date must be before the first voucher",
  masters_refused: "Some groups or ledgers were refused; fix them in Tally and export again",
  nothing_to_import: "The files hold nothing to import",
};

export type BlockingCode =
  | "opening_unbalanced"
  | "opening_invalid"
  | "opening_ledger_refused"
  | "opening_date_needed"
  | "opening_after_vouchers"
  | "masters_refused"
  | "nothing_to_import";

export type TallyPlanReport = {
  company: string | null;
  counts: {
    groups: number;
    ledgers: number;
    costCentres: number;
    voucherTypes: number;
    vouchers: number;
    cancelled: number;
    optional: number;
    deleted: number;
    postDated: number;
    toPost: number;
    unchanged: number;
    altered: number;
    older: number;
    refused: number;
    otherObjects: number;
  };
  groups: {
    predefined: number;
    linked: Array<{ name: string; code: string }>;
    create: Array<{ name: string; parent: string | null }>;
    refused: Array<{ name: string; code: RefusalCode }>;
  };
  ledgers: {
    create: number;
    createSample: Array<{ name: string; parent: string | null }>;
    linkedByGuid: number;
    linkByName: Array<{ name: string; code: string }>;
    refused: Array<{ name: string; code: RefusalCode }>;
  };
  costCentres: { create: string[]; existing: number };
  voucherTypes: {
    mapped: Array<{ name: string; base: VoucherType; count: number }>;
    refused: Array<{ name: string; count: number }>;
  };
  opening: {
    date: string | null;
    byGroup: Array<{ group: string; debit: number; credit: number }>;
    debit: number;
    credit: number;
    difference: number;
    balanced: boolean;
    lines: number;
  };
  months: Array<{ month: string; type: VoucherType; count: number; amount: number }>;
  refusals: Array<{
    guid: string | null;
    date: string | null;
    number: string | null;
    type: string | null;
    code: RefusalCode;
  }>;
  refusedTotal: number;
  warnings: { costCentresDropped: number; openingBills: number; foreignCurrency: number };
  firstDate: string | null;
  lastDate: string | null;
  blocking: BlockingCode[];
};

export type TallyPlan = { report: TallyPlanReport; masters: StagedRow[]; vouchers: StagedRow[] };

const lower = (s: string) => s.trim().toLowerCase();
const MAX_LISTED = 300;

/** Several parsed files as one (masters and vouchers may come in separate files). Later files win for the same key. */
export function mergeParsed(files: readonly TallyParseResult[]): TallyParseResult {
  function latest<T extends object>(rows: T[], key: (r: T) => string | null): T[] {
    const alter = (r: T) => ("alterId" in r ? Number(r.alterId ?? 0) : 0);
    const m = new Map<string, T>();
    const loose: T[] = [];
    for (const r of rows) {
      const k = key(r);
      if (k === null) {
        loose.push(r);
        continue;
      }
      const prev = m.get(k);
      if (!prev || alter(r) >= alter(prev)) m.set(k, r);
    }
    return [...m.values(), ...loose];
  }
  return {
    encoding: files[0]?.encoding ?? "utf-8",
    reportName: files.map((f) => f.reportName).find(Boolean) ?? null,
    company: files.map((f) => f.company).find(Boolean) ?? null,
    groups: latest(
      files.flatMap((f) => f.groups),
      (g) => lower(g.name),
    ),
    ledgers: latest(
      files.flatMap((f) => f.ledgers),
      (l) => lower(l.name),
    ),
    costCentres: latest(
      files.flatMap((f) => f.costCentres),
      (c) => lower(c.name),
    ),
    currencies: files.flatMap((f) => f.currencies),
    voucherTypes: latest(
      files.flatMap((f) => f.voucherTypes),
      (v) => lower(v.name),
    ),
    vouchers: latest(
      files.flatMap((f) => f.vouchers),
      (v) => v.guid,
    ),
    otherObjects: files.reduce((a, f) => a + f.otherObjects, 0),
  };
}

/** The base voucher type of a Tally voucher type name, following custom types' PARENT; null when not one of the eight. */
export function resolveVoucherType(
  name: string | null,
  parents: ReadonlyMap<string, string | null>,
): VoucherType | null {
  let cur = name ? lower(name) : null;
  for (let i = 0; cur && i < 12; i++) {
    const base = TALLY_BASE_TYPES[cur];
    if (base) return base;
    const p = parents.get(cur);
    cur = p ? lower(p) : null;
  }
  return null;
}

/** Day before the first day of the month holding `date`. */
export function dayBeforeMonth(date: string): string {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

type Line = {
  ledger: string;
  ledger_guid?: string;
  debit: number;
  credit: number;
  cost_centre?: string;
  description?: string;
  currency?: string;
  fx_rate?: number;
  amount_fx?: number;
};

function entryLines(
  e: TallyEntry,
  ledgerGuid: string | undefined,
  iso: (fx: TallyEntry["fx"]) => string | null,
  dropped: { n: number },
): Line[] {
  const base = (cents: number): Line => ({
    ledger: e.ledger,
    ...(ledgerGuid ? { ledger_guid: ledgerGuid } : {}),
    debit: e.side === "debit" ? centsToAmount(cents) : 0,
    credit: e.side === "credit" ? centsToAmount(cents) : 0,
  });
  const bills = e.bills.length
    ? cleanDescription(e.bills.map((b) => `${b.type ?? "Bill"} ${b.name}`).join("; "))
    : null;
  const withDesc = (l: Line): Line => (bills ? { ...l, description: bills } : l);
  if (e.costCentres.length > 0) {
    const allocated = e.costCentres.reduce((a, c) => a + c.cents, 0);
    if (e.categories === 1 && allocated <= e.cents) {
      const lines = e.costCentres.map((c) => withDesc({ ...base(c.cents), cost_centre: c.name }));
      if (allocated < e.cents) lines.push(withDesc(base(e.cents - allocated)));
      return lines;
    }
    dropped.n++; // several categories in parallel (or over-allocated): the amount stays whole, the split is not guessed
  }
  const line = withDesc(base(e.cents));
  const currency = iso(e.fx);
  if (e.fx && currency && e.fx.rate && currency !== "AED")
    return [{ ...line, currency, fx_rate: e.fx.rate, amount_fx: e.fx.amountFx }];
  return [line];
}

/** The dry run. `openingDate` overrides the default (the day before the first voucher's month). */
export function planTallyImport(
  parsed: TallyParseResult,
  ctx: PlanContext,
  opts: { openingDate?: string | null } = {},
): TallyPlan {
  const blocking = new Set<BlockingCode>();
  const accByGuid = new Map(
    ctx.accounts.filter((a) => a.tally_guid).map((a) => [a.tally_guid!, a]),
  );
  const accByName = new Map(ctx.accounts.map((a) => [lower(a.name), a]));
  const systemByTally = new Map(
    ctx.accounts
      .filter((a) => a.is_system && a.is_group && a.tally_group)
      .map((a) => [lower(a.tally_group!), a]),
  );
  const predefined = new Set(TALLY_GROUPS.map((g) => lower(g.name)));
  const retained = [...ctx.accounts]
    .filter((a) => a.control === "retained_earnings" && !a.is_group)
    .sort((a, b) => (a.code < b.code ? -1 : 1))[0];

  // ---- groups (parents first) ----
  const fileGroups = new Map(parsed.groups.map((g) => [lower(g.name), g]));
  const fileLedgerNames = new Set(parsed.ledgers.map((l) => lower(l.name)));
  const groupOut: TallyPlanReport["groups"] = {
    predefined: 0,
    linked: [],
    create: [],
    refused: [],
  };
  const masters: StagedRow[] = [];
  const refusedGroups = new Set<string>();
  const ordered: TallyGroupRec[] = [];
  const seen = new Set<string>();
  const visit = (g: TallyGroupRec, depth: number) => {
    const k = lower(g.name);
    if (seen.has(k) || depth > 64) return;
    seen.add(k);
    const p = g.parent ? fileGroups.get(lower(g.parent)) : undefined;
    if (p) visit(p, depth + 1);
    ordered.push(g);
  };
  for (const g of [...parsed.groups].sort((a, b) => (lower(a.name) < lower(b.name) ? -1 : 1)))
    visit(g, 0);

  const groupKnown = (name: string) => {
    const k = lower(name);
    if (refusedGroups.has(k)) return false;
    if (fileGroups.has(k)) return true;
    const a = accByName.get(k) ?? systemByTally.get(k);
    return !!a && a.is_group;
  };
  for (const g of ordered) {
    const k = lower(g.name);
    const row = (payload: Record<string, unknown>) =>
      masters.push({
        seq: masters.length + 1,
        kind: "group",
        guid: g.guid,
        alter_id: g.alterId,
        payload: { name: g.name, ...payload },
      });
    const refuse = (code: RefusalCode) => {
      refusedGroups.add(k);
      groupOut.refused.push({ name: g.name, code });
    };
    if (g.name.length > 120) {
      refuse("name_too_long");
      continue;
    }
    const sys = systemByTally.get(k);
    if (predefined.has(k) && sys) {
      groupOut.predefined++;
      row({ system_code: sys.code });
      continue;
    }
    const existing = (g.guid && accByGuid.get(g.guid)) || accByName.get(k);
    if (existing && !existing.is_group) {
      refuse("name_clash");
      continue;
    }
    if (fileLedgerNames.has(k)) {
      refuse("name_clash");
      continue;
    }
    if (existing) {
      groupOut.linked.push({ name: g.name, code: existing.code });
      row({ link_id: existing.id });
      continue;
    }
    if (g.parent === null) {
      if (g.isRevenue === null || g.isDeemedPositive === null) {
        refuse("nature_unknown");
        continue;
      }
      // Tally's four natures: revenue + deemed positive = Expenses, revenue = Income, deemed positive = Assets, else Liabilities
      const nature = g.isRevenue
        ? g.isDeemedPositive
          ? "expense"
          : "income"
        : g.isDeemedPositive
          ? "asset"
          : "liability";
      groupOut.create.push({ name: g.name, parent: null });
      row({ parent: null, nature, gross: g.affectsGrossProfit === true });
      continue;
    }
    if (!groupKnown(g.parent)) {
      refuse("parent_unknown");
      continue;
    }
    groupOut.create.push({ name: g.name, parent: g.parent });
    row({ parent: g.parent, parent_guid: fileGroups.get(lower(g.parent))?.guid ?? null });
  }

  // ---- cost centres (from the masters and from the vouchers) ----
  const ccExisting = new Set(ctx.costCentres.map((c) => lower(c.name)));
  const ccCreate = new Map<string, string>();
  const addCc = (name: string) => {
    const k = lower(name);
    if (!ccExisting.has(k) && !ccCreate.has(k) && name.length <= 80) ccCreate.set(k, name);
  };
  for (const c of parsed.costCentres) addCc(c.name);
  for (const v of parsed.vouchers)
    for (const e of v.entries) for (const c of e.costCentres) addCc(c.name);

  // ---- ledgers ----
  const ledgerOut: TallyPlanReport["ledgers"] = {
    create: 0,
    createSample: [],
    linkedByGuid: 0,
    linkByName: [],
    refused: [],
  };
  const refusedLedgers = new Set<string>();
  const ledgerGuids = new Map<string, string>();
  const ledgerRows: StagedRow[] = [];
  for (const l of [...parsed.ledgers].sort((a, b) => (lower(a.name) < lower(b.name) ? -1 : 1))) {
    const k = lower(l.name);
    if (l.guid) ledgerGuids.set(k, l.guid);
    const row = (payload: Record<string, unknown>) =>
      ledgerRows.push({
        seq: 0,
        kind: "ledger",
        guid: l.guid,
        alter_id: l.alterId,
        payload: { name: l.name, opening: centsToAmount(l.openingDrMinusCr), ...payload },
      });
    const refuse = (code: RefusalCode) => {
      refusedLedgers.add(k);
      ledgerOut.refused.push({ name: l.name, code });
    };
    if (l.name.length > 120) {
      refuse("name_too_long");
      continue;
    }
    const byGuid = l.guid ? accByGuid.get(l.guid) : undefined;
    if (k === TALLY_PL_LEDGER && l.parent === null) {
      // Tally's accumulated profit: Pulse's retained earnings account (its name is kept)
      const target = byGuid && !byGuid.is_group ? byGuid : retained;
      if (!target) {
        refuse("no_retained_earnings");
        continue;
      }
      if (target === byGuid) ledgerOut.linkedByGuid++;
      else ledgerOut.linkByName.push({ name: l.name, code: target.code });
      row({ link_id: target.id, special: "retained_earnings" });
      continue;
    }
    if (byGuid && !byGuid.is_group) {
      ledgerOut.linkedByGuid++;
      row({ link_id: byGuid.id });
      continue;
    }
    const byName = accByName.get(k);
    if ((byName && byName.is_group) || fileGroups.has(k)) {
      refuse("name_clash");
      continue;
    }
    if (byName) {
      ledgerOut.linkByName.push({ name: l.name, code: byName.code });
      row({ link_id: byName.id });
      continue;
    }
    if (!l.parent || !groupKnown(l.parent)) {
      refuse("parent_unknown");
      continue;
    }
    ledgerOut.create++;
    if (ledgerOut.createSample.length < MAX_LISTED)
      ledgerOut.createSample.push({ name: l.name, parent: l.parent });
    row({ parent: l.parent, parent_guid: fileGroups.get(lower(l.parent))?.guid ?? null });
  }
  if (groupOut.refused.length || ledgerOut.refused.length) blocking.add("masters_refused");
  for (const name of [...ccCreate.values()].sort())
    masters.push({
      seq: masters.length + 1,
      kind: "cost_centre",
      guid: null,
      alter_id: null,
      payload: { name },
    });
  for (const r of ledgerRows) masters.push({ ...r, seq: masters.length + 1 });

  // ---- vouchers ----
  const typeParents = new Map(parsed.voucherTypes.map((t) => [lower(t.name), t.parent]));
  const iso = (fx: TallyEntry["fx"]) => fx?.currency ?? null;
  const posted = new Map(ctx.tallyJournals.map((j) => [j.guid, j.version]));
  const ledgerKnown = (name: string) => {
    const k = lower(name);
    if (refusedLedgers.has(k)) return false;
    if (fileLedgerNames.has(k)) return true;
    const a = accByName.get(k);
    return !!a && !a.is_group;
  };
  const counts: TallyPlanReport["counts"] = {
    groups: parsed.groups.length,
    ledgers: parsed.ledgers.length,
    costCentres: parsed.costCentres.length,
    voucherTypes: parsed.voucherTypes.length,
    vouchers: parsed.vouchers.length,
    cancelled: 0,
    optional: 0,
    deleted: 0,
    postDated: 0,
    toPost: 0,
    unchanged: 0,
    altered: 0,
    older: 0,
    refused: 0,
    otherObjects: parsed.otherObjects,
  };
  const refusals: TallyPlanReport["refusals"] = [];
  const typeStats = new Map<string, { base: VoucherType | null; count: number }>();
  const months = new Map<
    string,
    { month: string; type: VoucherType; count: number; cents: number }
  >();
  const dropped = { n: 0 };
  let foreign = 0;
  const vouchers: StagedRow[] = [];
  let firstDate: string | null = null;
  let lastDate: string | null = null;
  const sorted = [...parsed.vouchers].sort((a, b) =>
    (a.date ?? "") < (b.date ?? "")
      ? -1
      : (a.date ?? "") > (b.date ?? "")
        ? 1
        : (a.guid ?? "") < (b.guid ?? "")
          ? -1
          : 1,
  );
  for (const v of sorted) {
    if (v.deleted) {
      counts.deleted++;
      continue;
    }
    if (v.cancelled) {
      counts.cancelled++;
      continue;
    }
    if (v.optional) {
      counts.optional++;
      continue;
    }
    const refuse = (code: RefusalCode) => {
      counts.refused++;
      if (refusals.length < MAX_LISTED)
        refusals.push({ guid: v.guid, date: v.date, number: v.number, type: v.typeName, code });
    };
    const base = resolveVoucherType(v.typeName, typeParents);
    if (v.typeName) {
      const t = typeStats.get(v.typeName) ?? { base, count: 0 };
      t.count++;
      typeStats.set(v.typeName, t);
    }
    if (v.problems.length > 0) {
      refuse(v.problems[0]);
      continue;
    }
    if (!base) {
      refuse("type_unknown");
      continue;
    }
    const unknown = v.entries.find((e) => !ledgerKnown(e.ledger));
    if (unknown) {
      refuse("ledger_unknown");
      continue;
    }
    const dr = v.entries.filter((e) => e.side === "debit").reduce((a, e) => a + e.cents, 0);
    const cr = v.entries.filter((e) => e.side === "credit").reduce((a, e) => a + e.cents, 0);
    if (dr !== cr) {
      refuse("unbalanced");
      continue;
    }
    if (v.entries.length < 2 || dr === 0) {
      refuse("too_few_lines");
      continue;
    }
    if (v.postDated) counts.postDated++;
    const version = Math.max(v.alterId ?? 1, 1);
    const had = posted.get(v.guid!);
    if (had !== undefined && had === version) {
      counts.unchanged++;
      continue;
    }
    if (had !== undefined && had > version) {
      counts.older++;
      continue;
    }
    if (had !== undefined) counts.altered++;
    counts.toPost++;
    const lines = v.entries.flatMap((e) =>
      entryLines(e, ledgerGuids.get(lower(e.ledger)), iso, dropped),
    );
    if (lines.some((l) => l.currency)) foreign++;
    if (lines.length > 500) {
      counts.toPost--;
      refuse("too_many_lines");
      continue;
    }
    const label = `Tally ${v.typeName}${v.number ? ` ${v.number}` : ""}`;
    const narration =
      cleanNarration(v.narration ? `${label}: ${v.narration}` : label) ?? label.slice(0, 300);
    vouchers.push({
      seq: vouchers.length + 1,
      kind: "voucher",
      guid: v.guid,
      alter_id: version,
      payload: {
        date: v.date,
        type: base,
        type_name: v.typeName,
        number: v.number,
        narration,
        lines,
      },
    });
    if (!firstDate || v.date! < firstDate) firstDate = v.date;
    if (!lastDate || v.date! > lastDate) lastDate = v.date;
    const mk = `${v.date!.slice(0, 7)}|${base}`;
    const m = months.get(mk) ?? { month: v.date!.slice(0, 7), type: base, count: 0, cents: 0 };
    m.count++;
    m.cents += dr;
    months.set(mk, m);
  }

  // ---- opening trial balance ----
  const rootOf = (parent: string | null): string => {
    let cur = parent;
    for (let i = 0; cur && i < 64; i++) {
      const g = fileGroups.get(lower(cur));
      if (!g || g.parent === null) return g?.name ?? cur;
      cur = g.parent;
    }
    return cur ?? "Primary";
  };
  const byGroup = new Map<string, { group: string; debit: number; credit: number }>();
  let odr = 0;
  let ocr = 0;
  let openingLines = 0;
  for (const l of parsed.ledgers as TallyLedgerRec[]) {
    if (l.openingInvalid) blocking.add("opening_invalid");
    if (l.openingDrMinusCr === 0) continue;
    if (refusedLedgers.has(lower(l.name))) blocking.add("opening_ledger_refused");
    openingLines++;
    const g =
      l.parent === null && lower(l.name) === TALLY_PL_LEDGER
        ? "Profit & Loss A/c"
        : rootOf(l.parent);
    const row = byGroup.get(g) ?? { group: g, debit: 0, credit: 0 };
    if (l.openingDrMinusCr > 0) {
      row.debit += l.openingDrMinusCr;
      odr += l.openingDrMinusCr;
    } else {
      row.credit -= l.openingDrMinusCr;
      ocr -= l.openingDrMinusCr;
    }
    byGroup.set(g, row);
  }
  if (odr !== ocr) blocking.add("opening_unbalanced");
  const openingDate = opts.openingDate ?? (firstDate ? dayBeforeMonth(firstDate) : null);
  if (openingLines > 0 && !openingDate) blocking.add("opening_date_needed");
  if (openingLines > 0 && openingDate && firstDate && openingDate >= firstDate)
    blocking.add("opening_after_vouchers");
  if (parsed.groups.length + parsed.ledgers.length + parsed.vouchers.length === 0)
    blocking.add("nothing_to_import");

  const report: TallyPlanReport = {
    company: parsed.company,
    counts,
    groups: {
      ...groupOut,
      linked: groupOut.linked.slice(0, MAX_LISTED),
      create: groupOut.create.slice(0, MAX_LISTED),
    },
    ledgers: {
      ...ledgerOut,
      linkByName: ledgerOut.linkByName.slice(0, MAX_LISTED),
      refused: ledgerOut.refused.slice(0, MAX_LISTED),
    },
    costCentres: {
      create: [...ccCreate.values()].sort().slice(0, MAX_LISTED),
      existing: ctx.costCentres.length,
    },
    voucherTypes: {
      mapped: [...typeStats.entries()]
        .filter(([, t]) => t.base)
        .map(([name, t]) => ({ name, base: t.base!, count: t.count }))
        .sort((a, b) => (a.name < b.name ? -1 : 1)),
      refused: [...typeStats.entries()]
        .filter(([, t]) => !t.base)
        .map(([name, t]) => ({ name, count: t.count }))
        .sort((a, b) => (a.name < b.name ? -1 : 1)),
    },
    opening: {
      date: openingLines > 0 ? openingDate : null,
      byGroup: [...byGroup.values()]
        .map((g) => ({
          group: g.group,
          debit: centsToAmount(g.debit),
          credit: centsToAmount(g.credit),
        }))
        .sort((a, b) => (a.group < b.group ? -1 : 1)),
      debit: centsToAmount(odr),
      credit: centsToAmount(ocr),
      difference: centsToAmount(odr - ocr),
      balanced: odr === ocr,
      lines: openingLines,
    },
    months: [...months.values()]
      .map((m) => ({
        month: m.month,
        type: m.type,
        count: m.count,
        amount: centsToAmount(m.cents),
      }))
      .sort((a, b) =>
        a.month === b.month ? (a.type < b.type ? -1 : 1) : a.month < b.month ? -1 : 1,
      ),
    refusals,
    refusedTotal: counts.refused,
    warnings: {
      costCentresDropped: dropped.n,
      openingBills: parsed.ledgers.reduce((a, l) => a + l.openingBills, 0),
      foreignCurrency: foreign,
    },
    firstDate,
    lastDate,
    blocking: [...blocking].sort(),
  };
  return { report, masters, vouchers };
}
