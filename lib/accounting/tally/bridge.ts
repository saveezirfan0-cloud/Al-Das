import { createHash, randomBytes } from "node:crypto";

import { cleanNarration, type JournalLineInput, type VoucherType } from "@/lib/accounting/journal";

import { KIND_CODES, type DayKind, type PushKind } from "./bridge-sources";
import type { TallyParseResult } from "./parse";

export * from "./bridge-sources";

/**
 * The Tally bridge (Phase 22J), pure parts: identities, tokens, the voucher Pulse sends for a journal, the daily revenue
 * summary and the job allow-list. The server (bridge-server.ts) and the database (migration 20261109000700) do the rest.
 *
 * A pushed voucher's REMOTEID / GUID is `pulse-<org>-<kind>-<id>-<version>` (a reversal adds `-r`): the same source and
 * version always give the same id, so a resend after an unknown answer can never create a second voucher in Tally. The
 * base (everything before the version) is built here; the database appends the version it decides on.
 */

// ---- identities ---------------------------------------------------------------------------------------------------

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * `pulse-<org without dashes>-<kind code>-<id>`: a short plain id, a UUID (without dashes) or a day key keep their
 * characters, anything else becomes `h` + 32 hex characters of its SHA-256. At most 83 characters; the database appends
 * `-<version>` (and `-r` for a reversal), within the column's 110.
 */
export function remoteIdBase(orgId: string, kind: PushKind, sourceId: string): string {
  const org = orgId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(org)) throw new Error("invalid org id");
  // only shapes that cannot collide once the separators are dropped keep their characters
  const part = /^[A-Za-z0-9]{1,40}$/.test(sourceId)
    ? sourceId
    : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceId)
      ? sourceId.replace(/-/g, "").toLowerCase()
      : /^\d{4}-\d{2}-\d{2}\|[A-Za-z0-9]{1,12}$/.test(sourceId)
        ? sourceId.replace(/[-|]/g, "")
        : `h${sha256(sourceId).slice(0, 32)}`;
  return `pulse-${org}-${KIND_CODES[kind]}-${part}`;
}

export const REMOTE_ID_RE = /^pulse-[A-Za-z0-9-]{1,110}$/;
export const isPulseRemoteId = (s: string) => REMOTE_ID_RE.test(s);

/** Tally's voucher number for a pushed voucher (Manual numbering, "Prevent duplicates" on): stable per REMOTEID. */
export function voucherNumberFor(remoteId: string): string {
  return `PB-${sha256(remoteId).slice(0, 10).toUpperCase()}${remoteId.endsWith("-r") ? "-R" : ""}`;
}

/** The dedicated voucher types the clinic creates in Tally, one per Pulse voucher type. */
export const TALLY_BRIDGE_TYPES: Record<Exclude<VoucherType, "opening">, string> = {
  journal: "Pulse Journal",
  contra: "Pulse Contra",
  payment: "Pulse Payment",
  receipt: "Pulse Receipt",
  sales: "Pulse Sales",
  purchase: "Pulse Purchase",
  credit_note: "Pulse Credit Note",
  debit_note: "Pulse Debit Note",
};

export function tallyTypeFor(v: string): string | null {
  return (TALLY_BRIDGE_TYPES as Record<string, string>)[v] ?? null;
}

// ---- device tokens and pairing codes ------------------------------------------------------------------------------

export const DEVICE_TOKEN_PREFIX = "ptb_";
const TOKEN_RE = /^ptb_[A-Za-z0-9_-]{43}$/;
const PAIR_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // no 0/O, 1/I/L, U
const PAIR_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

/** 256 random bits, shown to the connector once; only the SHA-256 is stored. */
export function generateDeviceToken(): string {
  return DEVICE_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export const isDeviceToken = (t: string) => TOKEN_RE.test(t);

export function hashSecret(value: string): string {
  return sha256(value);
}

/** A one-time pairing code (16 characters, about 78 bits), typed into the connector on the Tally PC within 30 minutes. */
export function generatePairingCode(): string {
  const bytes = randomBytes(16);
  const chars = [...bytes].map((b) => PAIR_ALPHABET[b % PAIR_ALPHABET.length]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}`;
}

/** The code as typed (spaces, lower case and missing dashes forgiven), or null when it cannot be one. */
export function normalisePairingCode(raw: string): string | null {
  const c = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (c.length !== 16) return null;
  const code = `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}-${c.slice(12, 16)}`;
  return PAIR_RE.test(code) ? code : null;
}

/** The token from an "Authorization: Bearer ptb_..." header, or null. */
export function bearerToken(header: string | null): string | null {
  const m = (header ?? "").match(/^Bearer\s+(\S+)$/);
  return m && isDeviceToken(m[1]) ? m[1] : null;
}

// ---- jobs ---------------------------------------------------------------------------------------------------------

/** The ONLY things the connector does. Anything else is refused on both sides; there is no delete. */
export const JOB_KINDS = [
  "export_masters_since",
  "export_vouchers_since",
  "export_trial_balance",
  "import_voucher",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export const isJobKind = (k: unknown): k is JobKind =>
  typeof k === "string" && (JOB_KINDS as readonly string[]).includes(k);

/** Outcomes the connector may report. */
export const RESULT_OUTCOMES = [
  "ok",
  "exists",
  "absent",
  "error",
  "timeout",
  "unreachable",
] as const;
export type ResultOutcome = (typeof RESULT_OUTCOMES)[number];

/** Connector error codes we keep (anything else becomes "error"). */
export const CONNECTOR_CODES = [
  "tally_unreachable",
  "no_company",
  "too_large",
  "refused_job",
  "bad_job",
  "timeout",
  "error",
] as const;
export const connectorCode = (c: unknown): string =>
  typeof c === "string" && (CONNECTOR_CODES as readonly string[]).includes(c) ? c : "error";

// ---- the voucher sent for a journal -------------------------------------------------------------------------------

/** One entry of a pushed voucher: a Tally ledger, its side, the amount in fils, optionally a cost centre. */
export type BridgeEntry = {
  ledger: string;
  side: "debit" | "credit";
  cents: number;
  cost_centre?: string;
};
/** What acc_tally_push.content holds (no ids, no patient data: ledger names, amounts, narration). */
export type BridgeContent = { narration: string; entries: BridgeEntry[] };

/** A journal as Pulse would post it (22D builders, 22E / 22F captures, 22H run lines). */
export type PulseJournal = {
  date: string;
  voucherType: VoucherType;
  narration: string;
  lines: ReadonlyArray<
    Pick<
      JournalLineInput,
      "account_id" | "account_code" | "debit" | "credit" | "branch_code" | "cost_centre_id"
    >
  >;
};

export type LedgerAccount = {
  id: string;
  code: string;
  name: string;
  tally_guid: string | null;
  tally_name: string | null;
  is_group: boolean;
};

export type MappingContext = {
  accounts: readonly LedgerAccount[];
  /** acc_cost_centres id -> name (Tally cost centre names, from the import). */
  costCentres: ReadonlyMap<string, string>;
  /** Branch code -> Tally cost centre (fin_ref_tally_ledgers, kind cost_centre). */
  branchCostCentres: ReadonlyMap<string, string>;
};

export type ResolveResult =
  | {
      action: "push";
      journalSha256: string;
      content: BridgeContent;
      amount: number;
      voucherType: VoucherType;
    }
  | {
      action: "hold";
      journalSha256: string;
      reason: "ledger_unmapped" | "account_unknown" | "unbalanced" | "voucher_type";
      detail: string;
      amount: number;
      voucherType: VoucherType;
    }
  | { action: "nothing" };

const cents = (n: number | null | undefined) => Math.round(Number(n ?? 0) * 100);

/** Lines netted per account and dimension (Tally takes the same ledger once per voucher in this design). */
function netLines(lines: PulseJournal["lines"]) {
  const m = new Map<
    string,
    { account: string; branch: string | null; costCentre: string | null; cents: number }
  >();
  for (const l of lines) {
    const account = l.account_id ? `id:${l.account_id}` : `code:${l.account_code ?? ""}`;
    const k = `${account}|${l.branch_code ?? ""}|${l.cost_centre_id ?? ""}`;
    const row = m.get(k) ?? {
      account,
      branch: l.branch_code ?? null,
      costCentre: l.cost_centre_id ?? null,
      cents: 0,
    };
    row.cents += cents(l.debit) - cents(l.credit);
    m.set(k, row);
  }
  return [...m.values()]
    .filter((r) => r.cents !== 0)
    .sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
}

/** A fingerprint of the journal itself (accounts, dimensions, amounts, date, type): a change means a new version. */
export function journalSha256(j: PulseJournal): string {
  const net = netLines(j.lines);
  return sha256(
    JSON.stringify([
      j.date,
      j.voucherType,
      net.map((r) => [r.account, r.branch, r.costCentre, r.cents]),
    ]),
  );
}

/**
 * The Tally voucher for a Pulse journal. Every account must be a ledger Tally knows (it has a Tally GUID from the import
 * or a pull); otherwise the item is held with the accounts listed, never sent with a guessed name. Cost centres: the
 * line's cost centre, else the branch's Tally cost centre when one is mapped, else none.
 */
export function resolveVoucher(j: PulseJournal, ctx: MappingContext): ResolveResult {
  const sha = journalSha256(j);
  const net = netLines(j.lines);
  if (net.length === 0) return { action: "nothing" };
  const debit = net.filter((r) => r.cents > 0).reduce((a, r) => a + r.cents, 0);
  const credit = -net.filter((r) => r.cents < 0).reduce((a, r) => a + r.cents, 0);
  const amount = debit / 100;
  const base = { journalSha256: sha, amount, voucherType: j.voucherType } as const;
  if (debit !== credit)
    return { action: "hold", ...base, reason: "unbalanced", detail: "Debits and credits differ." };
  if (!tallyTypeFor(j.voucherType))
    return {
      action: "hold",
      ...base,
      reason: "voucher_type",
      detail: `No Tally voucher type for ${j.voucherType}.`,
    };
  const byId = new Map(ctx.accounts.map((a) => [`id:${a.id}`, a]));
  const byCode = new Map(ctx.accounts.map((a) => [`code:${a.code}`, a]));
  const unknown: string[] = [];
  const unmapped: string[] = [];
  const entries: BridgeEntry[] = [];
  for (const r of net) {
    const acc = byId.get(r.account) ?? byCode.get(r.account);
    if (!acc || acc.is_group) {
      unknown.push(r.account.replace(/^(id|code):/, ""));
      continue;
    }
    if (!acc.tally_guid) {
      unmapped.push(`${acc.code} ${acc.name}`);
      continue;
    }
    const cc =
      (r.costCentre ? ctx.costCentres.get(r.costCentre) : undefined) ??
      (r.branch ? ctx.branchCostCentres.get(r.branch) : undefined);
    entries.push({
      ledger: (acc.tally_name ?? acc.name).trim(),
      side: r.cents > 0 ? "debit" : "credit",
      cents: Math.abs(r.cents),
      ...(cc ? { cost_centre: cc } : {}),
    });
  }
  if (unknown.length)
    return {
      action: "hold",
      ...base,
      reason: "account_unknown",
      detail: `Accounts not in the chart: ${[...new Set(unknown)].join(", ")}`.slice(0, 300),
    };
  if (unmapped.length)
    return {
      action: "hold",
      ...base,
      reason: "ledger_unmapped",
      detail: `No Tally ledger for: ${[...new Set(unmapped)].sort().join(", ")}`.slice(0, 300),
    };
  entries.sort(
    (a, b) =>
      (a.side === b.side ? 0 : a.side === "debit" ? -1 : 1) ||
      (a.ledger < b.ledger ? -1 : a.ledger > b.ledger ? 1 : 0) ||
      ((a.cost_centre ?? "") < (b.cost_centre ?? "") ? -1 : 1),
  );
  const narration = cleanNarration(`Pulse: ${j.narration}`) ?? "Pulse";
  return { action: "push", ...base, content: { narration, entries } };
}

/** The branch a journal belongs to for the daily summary: the first line that names one. */
export function journalBranch(j: PulseJournal): string {
  return j.lines.find((l) => l.branch_code)?.branch_code?.toUpperCase() ?? "ALL";
}

/**
 * One day's Unite invoices (or payments) of one branch as a single journal: every line netted per account, branch and
 * cost centre. Revenue stays per service category because each category posts to its own revenue account (22D rules).
 */
export function summariseDay(
  journals: readonly PulseJournal[],
  meta: { date: string; branch: string; kind: DayKind },
): PulseJournal {
  const lines = netLines(journals.flatMap((j) => j.lines)).map((r) => ({
    ...(r.account.startsWith("id:")
      ? { account_id: r.account.slice(3) }
      : { account_code: r.account.slice(5) }),
    debit: r.cents > 0 ? r.cents / 100 : 0,
    credit: r.cents < 0 ? -r.cents / 100 : 0,
    ...(r.branch ? { branch_code: r.branch } : {}),
    ...(r.costCentre ? { cost_centre_id: r.costCentre } : {}),
  }));
  const what = meta.kind === "unite_invoice_day" ? "Unite invoices" : "Unite payments and refunds";
  return {
    date: meta.date,
    voucherType: meta.kind === "unite_invoice_day" ? "sales" : "receipt",
    narration: `${what} ${meta.date} branch ${meta.branch} (${journals.length} item${journals.length === 1 ? "" : "s"})`,
    lines,
  };
}

/** The journal with every line on the other side (a reversing-accrual run's own reversal on the 1st of the next month). */
export function swapSides(j: PulseJournal, date: string, narration: string): PulseJournal {
  return {
    date,
    voucherType: j.voucherType,
    narration,
    lines: j.lines.map((l) => ({ ...l, debit: l.credit ?? 0, credit: l.debit ?? 0 })),
  };
}

/** A captured journal (acc_tally_bridge_capture's jsonb) as a PulseJournal, or null when it is not one. */
export function capturedJournal(raw: unknown): PulseJournal | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.date !== "string" || typeof o.voucher_type !== "string" || !Array.isArray(o.lines))
    return null;
  return {
    date: o.date.slice(0, 10),
    voucherType: o.voucher_type as VoucherType,
    narration: typeof o.narration === "string" ? o.narration : "",
    lines: (o.lines as Array<Record<string, unknown>>).map((l) => ({
      account_id: typeof l.account_id === "string" ? l.account_id : undefined,
      debit: Number(l.debit ?? 0),
      credit: Number(l.credit ?? 0),
      branch_code: typeof l.branch_code === "string" ? l.branch_code : null,
      cost_centre_id: typeof l.cost_centre_id === "string" ? l.cost_centre_id : null,
    })),
  };
}

/** Tally's own type each dedicated Pulse voucher type is created under (the clinic sets it as the type's parent). */
const TALLY_BASE_NAMES: Record<keyof typeof TALLY_BRIDGE_TYPES, string> = {
  journal: "Journal",
  contra: "Contra",
  payment: "Payment",
  receipt: "Receipt",
  sales: "Sales",
  purchase: "Purchase",
  credit_note: "Credit Note",
  debit_note: "Debit Note",
};

/**
 * The parsed answer with the Pulse voucher types known even when Tally's export did not list them, so a voucher the
 * bridge pushed always resolves to its base type when it comes back (a type Tally did list keeps Tally's parent).
 */
export function withPulseVoucherTypes(parsed: TallyParseResult): TallyParseResult {
  const have = new Set(parsed.voucherTypes.map((t) => t.name.trim().toLowerCase()));
  const extra = (Object.keys(TALLY_BRIDGE_TYPES) as Array<keyof typeof TALLY_BRIDGE_TYPES>)
    .filter((k) => !have.has(TALLY_BRIDGE_TYPES[k].toLowerCase()))
    .map((k) => ({ name: TALLY_BRIDGE_TYPES[k], guid: null, parent: TALLY_BASE_NAMES[k] }));
  return extra.length ? { ...parsed, voucherTypes: [...parsed.voucherTypes, ...extra] } : parsed;
}
