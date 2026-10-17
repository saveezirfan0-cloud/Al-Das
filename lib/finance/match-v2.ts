import { dayNumber } from "@/lib/documents/expiry";
import { aliasInText, findKeys, normalizeAlias } from "@/lib/finance/match-keys";
import type {
  Allocation,
  AutoRule,
  MatchInput,
  MatchRule,
  MatchSettings,
  OpenItem,
  OpenLine,
  Suggestion,
  SuggestionOption,
} from "@/lib/finance/match-v2-types";

/**
 * Matching engine v2 (docs/46 section 3), pure and deterministic. Money is whole cents inside; inputs are never changed.
 * Three rules, strongest first, one suggestion per line at most:
 *   reference    the item's payment reference is written on the bank line
 *   payer_sum    the payer is recognised and a set of its open items adds up to the line
 *   amount_date  nothing else fits: an item with the same amount and a near date (never automatic)
 * An ambiguous result is never guessed: it carries several options and `auto` stays false.
 */

// Compute bound for the subset search, not a business threshold.
const MAX_SET_CANDIDATES = 30;
const MAX_SET_COMBINATIONS = 6;
const MAX_AMOUNT_DATE_OPTIONS = 5;

const toCents = (n: number) => Math.round(n * 100);
const fromCents = (c: number) => c / 100;
const fmt = (c: number) => (c / 100).toFixed(2);

/** Allowed difference in cents: the larger of the fixed amount and the percentage of `base`. */
function tolerance(s: MatchSettings, base: number): number {
  return Math.round(Math.max(toCents(s.toleranceAmount), (base * s.tolerancePct) / 100));
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export type InsurerItem = OpenItem & {
  status: "open" | "part" | "paid" | "closed";
  source: "receipt" | "remittance" | "both";
  receiptAmount: number | null;
  batchSum: number | null;
  mismatch: boolean;
  matchedByMonthlyRun: boolean;
};

export type BuildItemsInput = {
  receipts: ReadonlyArray<{
    refKey: string;
    paymentRef: string;
    payerKey: string | null;
    amount: number;
    date: string;
  }>;
  batches: ReadonlyArray<{
    id: string;
    refKey: string | null;
    payerKey: string | null;
    date: string;
    sumPaid: number;
  }>;
  allocated: ReadonlyMap<string, number>;
  closed: ReadonlySet<string>;
  v1MatchedBatchIds: ReadonlySet<string>;
  today: string;
  settings: MatchSettings;
};

const cleanPayer = (p: string | null | undefined): string | null => {
  const v = (p ?? "").trim().toUpperCase();
  return v === "" ? null : v;
};

type Group = {
  ref: string;
  refKey: string | null;
  receipt: { paymentRef: string; payerKey: string | null; cents: number; date: string } | null;
  batches: Array<{ id: string; payerKey: string | null; date: string; cents: number }>;
};

export function isOpen(item: Pick<InsurerItem, "status">): boolean {
  return item.status === "open" || item.status === "part";
}

export function buildInsurerItems(input: BuildItemsInput): InsurerItem[] {
  void input.today; // kept in the contract: ageing is the caller's concern
  const groups = new Map<string, Group>();
  const group = (ref: string, key: string | null): Group => {
    let g = groups.get(ref);
    if (!g) groups.set(ref, (g = { ref, refKey: key, receipt: null, batches: [] }));
    return g;
  };

  // earliest receipt wins when a reference is repeated (the database refuses different figures anyway)
  const receipts = [...input.receipts].sort((a, b) => a.date.localeCompare(b.date) || a.refKey.localeCompare(b.refKey));
  for (const r of receipts) {
    const g = group(`ins|${r.refKey}`, r.refKey);
    g.receipt ??= { paymentRef: r.paymentRef, payerKey: cleanPayer(r.payerKey), cents: toCents(r.amount), date: r.date };
  }
  const batches = [...input.batches].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const b of batches) {
    const g = b.refKey ? group(`ins|${b.refKey}`, b.refKey) : group(`ins|batch:${b.id}`, null);
    g.batches.push({ id: b.id, payerKey: cleanPayer(b.payerKey), date: b.date, cents: toCents(b.sumPaid) });
  }

  const out: InsurerItem[] = [];
  for (const g of groups.values()) {
    const batchCents = g.batches.reduce((s, b) => s + b.cents, 0);
    const batchSum = g.batches.length ? batchCents : null;
    const total = g.receipt ? g.receipt.cents : (batchSum ?? 0);
    if (total <= 0) continue;
    const date = g.receipt ? g.receipt.date : g.batches[0].date;
    const payerKey = g.receipt?.payerKey ?? g.batches.find((b) => b.payerKey)?.payerKey ?? null;
    const byMonthlyRun = g.batches.some((b) => input.v1MatchedBatchIds.has(b.id));
    const allocated = byMonthlyRun ? total : Math.max(0, toCents(input.allocated.get(g.ref) ?? 0));
    const open = Math.max(0, total - allocated);
    const status: InsurerItem["status"] = input.closed.has(g.ref)
      ? "closed"
      : open === 0
        ? "paid"
        : allocated > 0
          ? "part"
          : "open";
    out.push({
      ref: g.ref,
      label: g.receipt?.paymentRef ?? (g.refKey ? `Remittance ${g.refKey}` : `Remittance batch ${g.batches[0].id.slice(0, 8)}`),
      payerKey,
      refKeys: g.refKey ? [g.refKey] : [],
      date,
      total: fromCents(total),
      allocated: fromCents(Math.min(allocated, total)),
      open: fromCents(open),
      status,
      source: g.receipt && batchSum !== null ? "both" : g.receipt ? "receipt" : "remittance",
      receiptAmount: g.receipt ? fromCents(g.receipt.cents) : null,
      batchSum: batchSum === null ? null : fromCents(batchSum),
      mismatch: g.receipt !== null && batchSum !== null && Math.abs(g.receipt.cents - batchCents) > tolerance(input.settings, g.receipt.cents),
      matchedByMonthlyRun: byMonthlyRun,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.ref.localeCompare(b.ref));
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

type CItem = { item: OpenItem; open: number; day: number | null };
type Draft = { lineId: string; rule: MatchRule; options: SuggestionOption[]; autoOk: boolean };

const byDateRef = (a: CItem, b: CItem) => a.item.date.localeCompare(b.item.date) || a.item.ref.localeCompare(b.item.ref);

/** One option: the line's open amount handed out in date order, each item capped at its own open amount. */
function makeOption(line: OpenLine, lineOpen: number, picks: CItem[], score: number, reasons: string[], aliasId: string | null): SuggestionOption {
  let left = lineOpen;
  const allocations: Allocation[] = [];
  for (const p of [...picks].sort(byDateRef)) {
    const give = Math.min(p.open, left);
    if (give <= 0) continue;
    left -= give;
    allocations.push({ lineId: line.id, itemRef: p.item.ref, amount: fromCents(give), itemTotal: p.item.total });
  }
  const given = (ref: string) => toCents(allocations.find((a) => a.itemRef === ref)?.amount ?? 0);
  return {
    allocations,
    lineLeft: fromCents(left),
    itemsLeft: fromCents(picks.reduce((s, p) => s + p.open - given(p.item.ref), 0)),
    score,
    reasons,
    aliasId,
  };
}

function referenceRule(line: OpenLine, lineOpen: number, items: CItem[], keyMap: Map<string, CItem[]>, input: MatchInput): Draft | null {
  const s = input.settings;
  const found = findKeys(line.text, [...keyMap.keys()], s.refMinLength);
  if (found.length === 0) return null;
  const usable = (c: CItem) => !input.rejected.has(`${c.item.ref}|${line.id}`);
  const perKey = found.map((k) => ({ key: k, items: (keyMap.get(k) ?? []).filter(usable) })).filter((x) => x.items.length > 0)
    .sort((a, b) => byDateRef(a.items[0], b.items[0]) || a.key.localeCompare(b.key));
  if (perKey.length === 0) return null;
  const picks = new Map<string, CItem>();
  for (const k of perKey) for (const c of k.items) picks.set(c.item.ref, c);
  const sorted = [...picks.values()].sort(byDateRef);

  if (perKey.some((k) => k.items.length > 1)) {
    const options = sorted.map((c) =>
      makeOption(line, lineOpen, [c], 60, [`Payment reference ${perKey.find((k) => k.items.includes(c))!.key} found on the bank line but it belongs to more than one item`], null),
    );
    return { lineId: line.id, rule: "reference", options, autoOk: false };
  }

  const want = sorted.reduce((t, c) => t + c.open, 0);
  const diff = lineOpen - want;
  const reasons = perKey.map((k) => `Payment reference ${k.items[0].item.label} found on the bank line`);
  let score: number;
  let exactish = true;
  if (diff === 0) {
    score = 100;
    reasons.push("Amount exact");
  } else if (Math.abs(diff) <= tolerance(s, want)) {
    score = 95;
    reasons.push(`Amount within tolerance (difference ${fmt(Math.abs(diff))})`);
  } else if (diff < 0) {
    score = 80;
    exactish = false;
    reasons.push(`Bank paid ${fmt(lineOpen)} less than the ${fmt(want)} open: partial payment, ${fmt(-diff)} stays open on the item${sorted.length > 1 ? "s" : ""}`);
  } else {
    score = 80;
    exactish = false;
    reasons.push(`Bank paid ${fmt(diff)} more than the ${fmt(want)} open: the surplus stays unallocated on the line`);
  }
  return { lineId: line.id, rule: "reference", options: [makeOption(line, lineOpen, sorted, score, reasons, null)], autoOk: exactish };
}

/** Which payer does the narrative name? One only; two or more different payers -> null (skip the rule). */
function recognisePayer(line: OpenLine, input: MatchInput, items: CItem[]): { payer: string; aliasId: string | null } | null {
  const found = new Map<string, string | null>();
  const aliases = [...input.aliases].sort((a, b) => a.id.localeCompare(b.id));
  for (const a of aliases) {
    if (aliasInText(line.text, a.alias)) {
      const p = a.payerKey.trim().toUpperCase();
      if (!found.has(p) || found.get(p) === null) found.set(p, a.id);
    }
  }
  const payers = new Set<string>([...aliases.map((a) => a.payerKey.trim().toUpperCase()), ...items.map((c) => c.item.payerKey).filter((p): p is string => !!p)]);
  for (const p of payers) {
    const asAlias = normalizeAlias(p);
    if (!found.has(p) && asAlias && asAlias.length >= input.settings.refMinLength && aliasInText(line.text, asAlias)) found.set(p, null);
  }
  if (found.size !== 1) return null;
  const [payer, aliasId] = [...found.entries()][0];
  return { payer, aliasId };
}

function subsets(cands: CItem[], target: number, tol: number, maxSize: number): CItem[][] {
  const out: CItem[][] = [];
  const walk = (size: number, start: number, chosen: CItem[], sum: number) => {
    if (out.length >= MAX_SET_COMBINATIONS) return;
    if (chosen.length === size) {
      if (Math.abs(sum - target) <= tol) out.push([...chosen]);
      return;
    }
    for (let i = start; i < cands.length; i++) {
      const next = sum + cands[i].open;
      if (next - target > tol) continue; // amounts are positive: this and any bigger pick overshoots
      chosen.push(cands[i]);
      walk(size, i + 1, chosen, next);
      chosen.pop();
      if (out.length >= MAX_SET_COMBINATIONS) return;
    }
  };
  for (let size = 1; size <= maxSize && out.length < MAX_SET_COMBINATIONS; size++) walk(size, 0, [], 0);
  return out;
}

function inWindow(c: CItem, lineDay: number, s: MatchSettings): boolean {
  if (c.day === null) return false;
  const d = c.day - lineDay;
  return d >= -s.itemLookBackDays && d <= s.windowDays;
}

function payerSumRule(line: OpenLine, lineOpen: number, lineDay: number, items: CItem[], input: MatchInput): Draft | null {
  const s = input.settings;
  const who = recognisePayer(line, input, items);
  if (!who) return null;
  const cands = items
    .filter((c) => c.item.payerKey === who.payer && inWindow(c, lineDay, s) && !input.rejected.has(`${c.item.ref}|${line.id}`))
    .sort((a, b) => Math.abs(a.day! - lineDay) - Math.abs(b.day! - lineDay) || byDateRef(a, b))
    .slice(0, MAX_SET_CANDIDATES)
    .sort(byDateRef);
  const combos = subsets(cands, lineOpen, tolerance(s, lineOpen), Math.max(1, s.setMaxItems));
  if (combos.length === 0) return null;
  const sumOf = (c: CItem[]) => c.reduce((t, x) => t + x.open, 0);
  combos.sort(
    (a, b) =>
      a.length - b.length ||
      Math.abs(sumOf(a) - lineOpen) - Math.abs(sumOf(b) - lineOpen) ||
      a.map((x) => x.item.date).join(",").localeCompare(b.map((x) => x.item.date).join(",")) ||
      a.map((x) => x.item.ref).join(",").localeCompare(b.map((x) => x.item.ref).join(",")),
  );
  const unique = combos.length === 1;
  const options = combos.map((combo) => {
    const why = [
      who.aliasId ? `Payer ${who.payer} recognised from an approved name on the bank line` : `Payer ${who.payer} named on the bank line`,
      combo.length === 1
        ? `One open item of ${fmt(sumOf(combo))} matches the bank amount`
        : `${combo.length} open items add up to ${fmt(sumOf(combo))}, matching the bank amount`,
    ];
    if (!unique) why.push(`${combos.length} different sets fit: a person must choose`);
    return makeOption(line, lineOpen, combo, unique ? (combo.length === 1 ? 90 : 85) : 60, why, who.aliasId);
  });
  return { lineId: line.id, rule: "payer_sum", options, autoOk: true };
}

function amountDateRule(line: OpenLine, lineOpen: number, lineDay: number, items: CItem[], input: MatchInput): Draft | null {
  const s = input.settings;
  const tol = tolerance(s, lineOpen);
  const near = items
    .filter((c) => Math.abs(c.open - lineOpen) <= tol && inWindow(c, lineDay, s) && !input.rejected.has(`${c.item.ref}|${line.id}`))
    .sort((a, b) => Math.abs(a.day! - lineDay) - Math.abs(b.day! - lineDay) || byDateRef(a, b))
    .slice(0, MAX_AMOUNT_DATE_OPTIONS);
  if (near.length === 0) return null;
  const options = near.map((c) => {
    const dist = Math.abs(c.day! - lineDay);
    return makeOption(line, lineOpen, [c], 70 - Math.min(20, dist), [
      `Amount ${fmt(c.open)} matches the bank amount`,
      `Item dated ${dist} day${dist === 1 ? "" : "s"} ${c.day! >= lineDay ? "after" : "before"} the bank line; no reference or payer name found`,
    ], null);
  });
  return { lineId: line.id, rule: "amount_date", options, autoOk: false };
}

export function matchV2(input: MatchInput): Suggestion[] {
  const items: CItem[] = input.items
    .map((item) => ({ item, open: toCents(item.open), day: dayNumber(item.date) }))
    .filter((c) => c.open > 0);
  const keyMap = new Map<string, CItem[]>();
  for (const c of items) for (const k of c.item.refKeys) keyMap.set(k, [...(keyMap.get(k) ?? []), c]);

  const lines = input.lines
    .filter((l) => toCents(l.open) > 0)
    .slice()
    .sort((a, b) => a.valueDate.localeCompare(b.valueDate) || a.id.localeCompare(b.id));

  const drafts: Draft[] = [];
  for (const line of lines) {
    const lineOpen = toCents(line.open);
    const lineDay = dayNumber(line.valueDate);
    const draft =
      referenceRule(line, lineOpen, items, keyMap, input) ??
      (lineDay === null ? null : payerSumRule(line, lineOpen, lineDay, items, input) ?? amountDateRule(line, lineOpen, lineDay, items, input));
    if (draft) drafts.push(draft);
  }

  // an item reachable from two lines (or a line from two suggestions) is contested: nobody gets it automatically
  const itemUse = new Map<string, Set<string>>();
  const lineUse = new Map<string, number>();
  for (const d of drafts) {
    lineUse.set(d.lineId, (lineUse.get(d.lineId) ?? 0) + 1);
    for (const o of d.options) for (const a of o.allocations) itemUse.set(a.itemRef, (itemUse.get(a.itemRef) ?? new Set()).add(d.lineId));
  }
  return drafts.map((d) => {
    const contested = (lineUse.get(d.lineId) ?? 0) > 1 || d.options.some((o) => o.allocations.some((a) => (itemUse.get(a.itemRef)?.size ?? 0) > 1));
    const auto = d.autoOk && d.options.length === 1 && d.rule !== "amount_date" && input.autoRules.has(d.rule as AutoRule) && !contested;
    return { lineId: d.lineId, rule: d.rule, options: d.options, auto };
  });
}
