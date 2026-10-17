// The requests sent to TallyPrime for the export jobs and the look-up (pure): a TypeScript copy of the connector's
// connector/tally-bridge/lib/envelopes.mjs, used when Pulse talks to Tally itself over the direct HTTPS connection
// (docs/44_TALLY_DIRECT_CONNECTION.md). tests/unit/accounting/tally/direct.test.ts checks both give the same bytes, so
// change them together. Built from typed values only (numbers, dates, the company name, a pulse- id), never from XML.

import { REMOTE_ID_RE } from "./bridge";

const COMPANY_MAX = 120;

/** XML text: the five specials escaped, control characters dropped. */
export function xmlText(value: unknown): string {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function company(name: unknown): string {
  const c = String(name ?? "").trim();
  if (!c || c.length > COMPANY_MAX) throw new Error("company name missing or too long");
  return c;
}

function alterId(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("invalid AlterID");
  return n;
}

/** YYYY-MM-DD -> YYYYMMDD (Tally's date) */
function tallyDate(d: string): string {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error("invalid date");
  return d.replace(/-/g, "");
}

function collectionRequest({
  id,
  companyName,
  type,
  fetch,
  filter,
  from,
  to,
}: {
  id: string;
  companyName: string;
  type: string;
  fetch: string;
  filter?: string;
  from?: string;
  to?: string;
}): string {
  const vars = [
    `<SVCURRENTCOMPANY>${xmlText(company(companyName))}</SVCURRENTCOMPANY>`,
    ...(from ? [`<SVFROMDATE TYPE="Date">${tallyDate(from)}</SVFROMDATE>`] : []),
    ...(to ? [`<SVTODATE TYPE="Date">${tallyDate(to)}</SVTODATE>`] : []),
    "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>",
  ];
  const filterTag = filter ? `<FILTER>${id}Filter</FILTER>` : "";
  const formula = filter
    ? `<SYSTEM TYPE="Formulae" NAME="${id}Filter">${xmlText(filter)}</SYSTEM>`
    : "";
  return [
    "<ENVELOPE>",
    `<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${id}</ID></HEADER>`,
    "<BODY><DESC>",
    `<STATICVARIABLES>${vars.join("")}</STATICVARIABLES>`,
    "<TDL><TDLMESSAGE>",
    `<COLLECTION NAME="${id}" ISMODIFY="No"><TYPE>${type}</TYPE><FETCH>${fetch}</FETCH>${filterTag}</COLLECTION>`,
    formula,
    "</TDLMESSAGE></TDL>",
    "</DESC></BODY>",
    "</ENVELOPE>",
  ].join("");
}

const MASTERS: [string, string][] = [
  [
    "Group",
    "GUID, MasterID, AlterID, Name, Parent, IsRevenue, AffectsGrossProfit, IsDeemedPositive",
  ],
  ["Ledger", "GUID, MasterID, AlterID, Name, Parent, OpeningBalance"],
  ["CostCentre", "GUID, MasterID, AlterID, Name, Parent, Category"],
];

/** Groups, ledgers and cost centres altered after `since` (one request each). */
export function mastersSinceRequests(companyName: string, since: number): string[] {
  const n = alterId(since);
  return MASTERS.map(([type, fetch]) =>
    collectionRequest({
      id: `PulseBridge${type}`,
      companyName,
      type,
      fetch,
      filter: `$AlterID > ${n}`,
    }),
  );
}

/**
 * Every voucher type (few, so all of them: Pulse resolves a custom type through its parent), then the vouchers altered
 * after `since`, dated from..to, with their ledger entries.
 */
export function vouchersSinceRequests(
  companyName: string,
  since: number,
  from: string,
  to: string,
): string[] {
  return [
    collectionRequest({
      id: "PulseBridgeVoucherTypes",
      companyName,
      type: "VoucherType",
      fetch: "GUID, MasterID, AlterID, Name, Parent",
    }),
    collectionRequest({
      id: "PulseBridgeVouchers",
      companyName,
      type: "Voucher",
      fetch:
        "GUID, RemoteID, MasterID, AlterID, Date, VoucherTypeName, VoucherNumber, Narration, IsCancelled, IsOptional, IsPostDated, IsDeleted, AllLedgerEntries.*",
      filter: `$AlterID > ${alterId(since)}`,
      from,
      to,
    }),
  ];
}

/** Every ledger's closing balance at `asAt` (the trial balance Pulse compares with its mirror). */
export function trialBalanceRequest(companyName: string, asAt: string): string {
  return collectionRequest({
    id: "PulseBridgeTrialBalance",
    companyName,
    type: "Ledger",
    fetch: "GUID, Name, Parent, ClosingBalance",
    from: asAt,
    to: asAt,
  });
}

/** A voucher by its REMOTEID or GUID on its date: asked before sending an import again after an unknown answer. */
export function lookupRequest(companyName: string, remoteId: string, date: string): string {
  if (!REMOTE_ID_RE.test(remoteId)) throw new Error("not a Pulse voucher id");
  return collectionRequest({
    id: "PulseBridgeLookup",
    companyName,
    type: "Voucher",
    fetch: "GUID, RemoteID, MasterID, AlterID, Date, VoucherNumber",
    filter: `$RemoteID = "${remoteId}" OR $GUID = "${remoteId}"`,
    from: date,
    to: date,
  });
}

/** True when Tally's answer to a look-up holds the voucher with this REMOTEID (or GUID). Same rule as validate.mjs. */
export function answerHoldsVoucher(text: string, remoteId: string): boolean {
  if (!REMOTE_ID_RE.test(remoteId)) return false;
  return (
    text.includes(`REMOTEID="${remoteId}"`) ||
    text.includes(`<REMOTEID>${remoteId}</REMOTEID>`) ||
    text.includes(`<GUID>${remoteId}</GUID>`)
  );
}

/** Tally's bytes as text (UTF-8, or UTF-16 with or without a byte order mark). Same rule as validate.mjs. */
export function decodeTally(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) {
    const sw = new Uint8Array(b.length - 2 - (b.length % 2));
    for (let i = 2; i + 1 < b.length; i += 2) {
      sw[i - 2] = b[i + 1];
      sw[i - 1] = b[i];
    }
    return new TextDecoder("utf-16le").decode(sw);
  }
  if (b.length >= 2 && b[0] !== 0 && b[1] === 0) return new TextDecoder("utf-16le").decode(b);
  return new TextDecoder("utf-8").decode(b);
}
