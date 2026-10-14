import {
  parseTallyAmount,
  parseTallyDate,
  tallyIsDebit,
  tallyToDrMinusCr,
  type TallyFx,
} from "./amounts";
import {
  boolOf,
  childrenNamed,
  decodeTallyBytes,
  objectName,
  scanTallyXml,
  textOf,
  type TallyEncoding,
  type XNode,
} from "./xml";

/**
 * A Tally XML export ("All Masters" and/or "Vouchers" / Day Book) as typed records (pure). Masters: GROUP, LEDGER,
 * COSTCENTRE, CURRENCY, VOUCHERTYPE. Vouchers: VOUCHER with its ledger entries (ALLLEDGERENTRIES.LIST or, in invoice
 * mode, LEDGERENTRIES.LIST plus the accounting allocations of the inventory entries), cost-centre and bill allocations
 * and foreign-currency amounts. Problems are recorded per voucher as codes; nothing is guessed. Signs follow
 * amounts.ts (TALLY_DEBIT_SIGN).
 */

export const MAX_ENTRIES_PER_VOUCHER = 450;

export type TallyGroupRec = {
  name: string;
  guid: string | null;
  alterId: number | null;
  /** null for a primary group ("Primary" / Tally's blank marker). */
  parent: string | null;
  isRevenue: boolean | null;
  affectsGrossProfit: boolean | null;
  isDeemedPositive: boolean | null;
};

export type TallyLedgerRec = {
  name: string;
  guid: string | null;
  alterId: number | null;
  parent: string | null;
  /** Pulse's sign: debit minus credit, in cents (fils). */
  openingDrMinusCr: number;
  openingInvalid: boolean;
  /** CLOSINGBALANCE as Pulse's sign (debit minus credit, fils) when the export carries it (the Tally bridge's trial
   * balance asks for it); null when absent or unreadable. */
  closingDrMinusCr: number | null;
  openingBills: number;
  currency: string | null;
};

export type TallyCostCentreRec = {
  name: string;
  guid: string | null;
  parent: string | null;
  category: string | null;
};
export type TallyCurrencyRec = { symbol: string; iso: string | null };
export type TallyVoucherTypeRec = { name: string; guid: string | null; parent: string | null };

export type TallyCostAllocation = { category: string | null; name: string; cents: number };
export type TallyBillAllocation = { name: string; type: string | null; cents: number };

export type TallyEntry = {
  ledger: string;
  side: "debit" | "credit";
  /** Always above zero; the side says which. */
  cents: number;
  fx: TallyFx | null;
  costCentres: TallyCostAllocation[];
  categories: number;
  bills: TallyBillAllocation[];
};

export type TallyVoucherProblem =
  | "no_guid"
  | "bad_date"
  | "no_type"
  | "bad_amount"
  | "sign_mismatch"
  | "entry_no_ledger"
  | "too_many_lines";

export type TallyVoucherRec = {
  guid: string | null;
  /** REMOTEID (attribute or element): the Tally bridge (22J) sends Pulse's own vouchers with "pulse-..." here. */
  remoteId: string | null;
  alterId: number | null;
  masterId: number | null;
  date: string | null;
  typeName: string | null;
  number: string | null;
  narration: string | null;
  cancelled: boolean;
  optional: boolean;
  postDated: boolean;
  deleted: boolean;
  entries: TallyEntry[];
  problems: TallyVoucherProblem[];
};

export type TallyParseResult = {
  encoding: TallyEncoding;
  reportName: string | null;
  company: string | null;
  groups: TallyGroupRec[];
  ledgers: TallyLedgerRec[];
  costCentres: TallyCostCentreRec[];
  currencies: TallyCurrencyRec[];
  voucherTypes: TallyVoucherTypeRec[];
  vouchers: TallyVoucherRec[];
  /** Objects of other kinds (stock items, units, ...), counted and ignored. */
  otherObjects: number;
};

const OBJECTS = new Set([
  "GROUP",
  "LEDGER",
  "COSTCENTRE",
  "COSTCATEGORY",
  "CURRENCY",
  "VOUCHERTYPE",
  "VOUCHER",
  "STOCKITEM",
  "STOCKGROUP",
  "UNIT",
  "GODOWN",
  "COMPANY",
]);

/** Tally writes a primary group's parent as "Primary", blank, or its blank marker (&#4; dropped, "Not Applicable"). */
export function cleanParent(raw: string | null): string | null {
  const t = (raw ?? "").trim();
  if (!t || /^(primary|not applicable)$/i.test(t)) return null;
  return t;
}

function intOf(node: XNode, name: string): number | null {
  const t = textOf(node, name);
  if (t === null || !/^-?\d{1,15}$/.test(t)) return null;
  return Number(t);
}

function guidOf(node: XNode): string | null {
  const g = textOf(node, "GUID") ?? node.attrs.GUID?.trim() ?? null;
  return g ? g.slice(0, 100) : null;
}

function readEntry(node: XNode, problems: Set<TallyVoucherProblem>): TallyEntry | null {
  const ledger = textOf(node, "LEDGERNAME");
  const amount = parseTallyAmount(textOf(node, "AMOUNT"));
  if (!amount.ok) {
    problems.add("bad_amount");
    return null;
  }
  if (amount.cents === 0) return null; // Tally keeps zero rows (for example a blank VAT line); they post nothing
  if (!ledger) {
    problems.add("entry_no_ledger");
    return null;
  }
  const debit = tallyIsDebit(amount.cents);
  const flag = boolOf(node, "ISDEEMEDPOSITIVE");
  if (flag !== null && flag !== debit) problems.add("sign_mismatch");
  const costCentres: TallyCostAllocation[] = [];
  const cats = childrenNamed(node, "CATEGORYALLOCATIONS.LIST");
  for (const cat of cats) {
    const category = textOf(cat, "CATEGORY");
    for (const cc of childrenNamed(cat, "COSTCENTREALLOCATIONS.LIST")) {
      const name = textOf(cc, "NAME");
      const a = parseTallyAmount(textOf(cc, "AMOUNT"));
      if (!a.ok) problems.add("bad_amount");
      else if (name && a.cents !== 0)
        costCentres.push({ category, name, cents: Math.abs(a.cents) });
    }
  }
  // older exports put the cost centres straight under the entry
  for (const cc of childrenNamed(node, "COSTCENTREALLOCATIONS.LIST")) {
    const name = textOf(cc, "NAME");
    const a = parseTallyAmount(textOf(cc, "AMOUNT"));
    if (!a.ok) problems.add("bad_amount");
    else if (name && a.cents !== 0)
      costCentres.push({ category: null, name, cents: Math.abs(a.cents) });
  }
  const bills: TallyBillAllocation[] = [];
  for (const b of childrenNamed(node, "BILLALLOCATIONS.LIST")) {
    const name = textOf(b, "NAME");
    const a = parseTallyAmount(textOf(b, "AMOUNT"));
    if (name && a.ok) bills.push({ name, type: textOf(b, "BILLTYPE"), cents: Math.abs(a.cents) });
  }
  return {
    ledger,
    side: debit ? "debit" : "credit",
    cents: Math.abs(amount.cents),
    fx: amount.fx,
    costCentres,
    categories: new Set(costCentres.map((c) => c.category ?? "")).size,
    bills,
  };
}

function readVoucher(node: XNode): TallyVoucherRec {
  const problems = new Set<TallyVoucherProblem>();
  const guid = guidOf(node);
  if (!guid) problems.add("no_guid");
  const date = parseTallyDate(textOf(node, "DATE"));
  if (!date) problems.add("bad_date");
  const typeName = textOf(node, "VOUCHERTYPENAME") ?? node.attrs.VCHTYPE?.trim() ?? null;
  if (!typeName) problems.add("no_type");
  const entryNodes = [
    ...childrenNamed(node, "ALLLEDGERENTRIES.LIST"),
    ...childrenNamed(node, "LEDGERENTRIES.LIST"),
    ...[
      ...childrenNamed(node, "ALLINVENTORYENTRIES.LIST"),
      ...childrenNamed(node, "INVENTORYENTRIES.LIST"),
    ].flatMap((inv) => childrenNamed(inv, "ACCOUNTINGALLOCATIONS.LIST")),
  ];
  const entries: TallyEntry[] = [];
  for (const e of entryNodes) {
    const entry = readEntry(e, problems);
    if (entry) entries.push(entry);
  }
  if (entries.length > MAX_ENTRIES_PER_VOUCHER) problems.add("too_many_lines");
  const remote = (node.attrs.REMOTEID ?? textOf(node, "REMOTEID") ?? "").trim();
  return {
    guid,
    remoteId: remote ? remote.slice(0, 120) : null,
    alterId: intOf(node, "ALTERID"),
    masterId: intOf(node, "MASTERID"),
    date,
    typeName,
    number: textOf(node, "VOUCHERNUMBER")?.slice(0, 60) ?? null,
    narration: textOf(node, "NARRATION"),
    cancelled: boolOf(node, "ISCANCELLED") === true,
    optional: boolOf(node, "ISOPTIONAL") === true,
    postDated: boolOf(node, "ISPOSTDATED") === true,
    deleted: boolOf(node, "ISDELETED") === true || /^delete$/i.test(node.attrs.ACTION ?? ""),
    entries,
    problems: [...problems],
  };
}

/** Parses the bytes of one Tally XML file. Throws TallyParseError when the file is not usable at all. */
export function parseTallyXml(bytes: Uint8Array): TallyParseResult {
  const { text, encoding } = decodeTallyBytes(bytes);
  const out: TallyParseResult = {
    encoding,
    reportName: null,
    company: null,
    groups: [],
    ledgers: [],
    costCentres: [],
    currencies: [],
    voucherTypes: [],
    vouchers: [],
    otherObjects: 0,
  };
  const scan = scanTallyXml(text, OBJECTS, (node) => {
    const name = objectName(node);
    switch (node.name) {
      case "GROUP":
        if (name)
          out.groups.push({
            name,
            guid: guidOf(node),
            alterId: intOf(node, "ALTERID"),
            parent: cleanParent(textOf(node, "PARENT")),
            isRevenue: boolOf(node, "ISREVENUE"),
            affectsGrossProfit: boolOf(node, "AFFECTSGROSSPROFIT"),
            isDeemedPositive: boolOf(node, "ISDEEMEDPOSITIVE"),
          });
        return;
      case "LEDGER": {
        if (!name) return;
        const opening = parseTallyAmount(textOf(node, "OPENINGBALANCE"));
        const closingText = textOf(node, "CLOSINGBALANCE");
        const closing = closingText === null ? null : parseTallyAmount(closingText);
        out.ledgers.push({
          name,
          guid: guidOf(node),
          alterId: intOf(node, "ALTERID"),
          parent: cleanParent(textOf(node, "PARENT")),
          openingDrMinusCr: opening.ok ? tallyToDrMinusCr(opening.cents) : 0,
          openingInvalid: !opening.ok,
          closingDrMinusCr: closing && closing.ok ? tallyToDrMinusCr(closing.cents) : null,
          openingBills: childrenNamed(node, "BILLALLOCATIONS.LIST").length,
          currency: textOf(node, "CURRENCYNAME"),
        });
        return;
      }
      case "COSTCENTRE":
        if (name)
          out.costCentres.push({
            name,
            guid: guidOf(node),
            parent: cleanParent(textOf(node, "PARENT")),
            category: textOf(node, "CATEGORY"),
          });
        return;
      case "CURRENCY":
        if (name) out.currencies.push({ symbol: name, iso: textOf(node, "ISOCURRENCYCODE") });
        return;
      case "VOUCHERTYPE":
        if (name)
          out.voucherTypes.push({
            name,
            guid: guidOf(node),
            parent: cleanParent(textOf(node, "PARENT")),
          });
        return;
      case "VOUCHER":
        out.vouchers.push(readVoucher(node));
        return;
      default:
        out.otherObjects++;
    }
  });
  out.reportName = scan.reportName;
  out.company = scan.company;
  return out;
}
