// The requests the connector sends to TallyPrime for the three export jobs and the look-up (pure).
//
// They are built HERE from typed values (numbers, dates, the company name, a pulse- id), never taken from Pulse as XML:
// the only XML the connector forwards from Pulse is one voucher import, checked by validate.mjs. The shapes follow
// Tally's documented "Export / Collection" request with an inline TDL collection and a formula filter (research
// addendum A.1). The field and method names ($AlterID, $RemoteID, ClosingBalance, SVFROMDATE / SVTODATE) are standard
// TDL in community use but were NOT verified against a real TallyPrime company.

const COMPANY_MAX = 120;

/** XML text: the five specials escaped, control characters dropped. */
export function xmlText(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function company(name) {
  const c = String(name ?? "").trim();
  if (!c || c.length > COMPANY_MAX) throw new Error("company name missing or too long");
  return c;
}

function alterId(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("invalid AlterID");
  return n;
}

/** YYYY-MM-DD -> YYYYMMDD (Tally's date) */
function tallyDate(d) {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error("invalid date");
  return d.replace(/-/g, "");
}

function collectionRequest({ id, companyName, type, fetch, filter, from, to }) {
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

const MASTERS = [
  [
    "Group",
    "GUID, MasterID, AlterID, Name, Parent, IsRevenue, AffectsGrossProfit, IsDeemedPositive",
  ],
  ["Ledger", "GUID, MasterID, AlterID, Name, Parent, OpeningBalance"],
  ["CostCentre", "GUID, MasterID, AlterID, Name, Parent, Category"],
];

/** Groups, ledgers and cost centres altered after `since` (one request each). */
export function mastersSinceRequests(companyName, since) {
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
export function vouchersSinceRequests(companyName, since, from, to) {
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
export function trialBalanceRequest(companyName, asAt) {
  return collectionRequest({
    id: "PulseBridgeTrialBalance",
    companyName,
    type: "Ledger",
    fetch: "GUID, Name, Parent, ClosingBalance",
    from: asAt,
    to: asAt,
  });
}

export const REMOTE_ID_RE = /^pulse-[A-Za-z0-9-]{1,110}$/;

/** A voucher by its REMOTEID or GUID on its date: asked before sending an import again after an unknown answer. */
export function lookupRequest(companyName, remoteId, date) {
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
