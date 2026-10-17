import {
  childrenNamed,
  decodeTallyBytes,
  scanTallyXml,
  textOf,
  TallyParseError,
  type XNode,
} from "@/lib/accounting/tally/xml";
import {
  MAX_REMITTANCE_ROWS,
  MAX_REMITTANCE_XML_BYTES,
  REMITTANCE_FIELDS,
  REMITTANCE_XML,
  type RemitFieldName,
} from "@/lib/finance/remittance-mapping";
import { num } from "@/lib/finance/scalars";

/**
 * A payer's XML remittance advice (as Diligence or the DHA e-claim portal downloads it) -> the same header-plus-rows table
 * the .xlsx and .csv readers produce, so parseRemittanceTable (validation, sanitising, row numbers) and everything after it
 * are reused unchanged. Pure. Reads only the elements named in REMITTANCE_XML; member, patient and card elements are never
 * touched. Fails closed: a wrong root, a truncated file, a claim without its ID / payment reference / activities, an
 * activity without its code or payment amount, a doctype or entity declaration, too many rows. Errors carry a code, never
 * a value from the file. The scanner is the forgiving one written for Tally, so completeness is checked here.
 */

export class RemittanceFileError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RemittanceFileError";
  }
}

/** The file is XML when its first non-blank character is "<" (UTF-8 or UTF-16, with or without a byte order mark). */
export function looksLikeRemittanceXml(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;
  try {
    return /^\s*</.test(decodeTallyBytes(bytes.subarray(0, 64)).text);
  } catch {
    return false;
  }
}

/** The columns written for an XML advice: the first alias of each field, which the table parser recognises. */
const COLUMNS: readonly RemitFieldName[] = [
  "remittance_ref",
  "paid_on",
  "payer_id",
  "invoice_no",
  "cpt_code",
  "quantity",
  "claimed_amount",
  "paid_amount",
  "denied_amount",
  "denial_code",
];

const up = (s: string) => s.toUpperCase();
const CLAIM = up(REMITTANCE_XML.claim);
const ACTIVITY = up(REMITTANCE_XML.activity);

const cents = (n: number) => Math.round(n * 100);

export function remittanceXmlToTable(bytes: Uint8Array): string[][] {
  if (bytes.length > MAX_REMITTANCE_XML_BYTES) throw new RemittanceFileError("file_too_large");
  let text: string;
  try {
    text = decodeTallyBytes(bytes).text.replace(/^﻿/, "");
  } catch {
    throw new RemittanceFileError("unreadable_file");
  }
  if (/<!(DOCTYPE|ENTITY)/i.test(text)) throw new RemittanceFileError("xml_not_allowed");

  const rootName = /^\s*(?:<\?[\s\S]*?\?>\s*|<!--[\s\S]*?-->\s*)*<\s*([^\s>/]+)/.exec(text)?.[1];
  if (!rootName || up(rootName) !== up(REMITTANCE_XML.root))
    throw new RemittanceFileError("xml_unexpected_root");
  // a file cut short never reaches the closing root tag
  if (!new RegExp(`</\\s*${rootName.replace(/\./g, "\\.")}\\s*>\\s*$`, "i").test(text))
    throw new RemittanceFileError("xml_truncated");

  const claims: XNode[] = [];
  try {
    scanTallyXml(text, new Set([CLAIM]), (n) => claims.push(n));
  } catch (e) {
    throw new RemittanceFileError(
      e instanceof TallyParseError && e.code === "too_many_objects"
        ? "too_many_rows"
        : "xml_malformed",
    );
  }
  // the scanner closes unclosed tags quietly, so every claim and activity tag must be opened and closed exactly once
  for (const name of [REMITTANCE_XML.claim, REMITTANCE_XML.activity]) {
    const tags = text.match(new RegExp(`<\\s*${name}(?=[\\s>/])[^>]*>`, "gi")) ?? [];
    const opens = tags.filter((t) => !t.endsWith("/>")).length;
    const closes = text.match(new RegExp(`</\\s*${name}\\s*>`, "gi"))?.length ?? 0;
    if (opens !== closes || tags.length !== opens) throw new RemittanceFileError("xml_malformed");
  }
  if (claims.length === 0) throw new RemittanceFileError("xml_no_claims");

  const header = COLUMNS.map((f) => REMITTANCE_FIELDS[f].aliases[0]);
  const rows: string[][] = [header];
  for (const claim of claims) {
    const invoice = textOf(claim, up(REMITTANCE_XML.claimFields.invoice_no));
    const ref = textOf(claim, up(REMITTANCE_XML.claimFields.remittance_ref));
    const activities = childrenNamed(claim, ACTIVITY);
    if (!invoice || !ref || activities.length === 0)
      throw new RemittanceFileError("xml_claim_incomplete");
    const claimDenial = textOf(claim, up(REMITTANCE_XML.claimFields.denial_code));
    for (const act of activities) {
      const af = REMITTANCE_XML.activityFields;
      const code = textOf(act, up(af.cpt_code));
      const paid = textOf(act, up(af.paid_amount));
      if (!code || paid === null) throw new RemittanceFileError("xml_activity_incomplete");
      const net = textOf(act, up(af.claimed_amount));
      const denial = textOf(act, up(af.denial_code)) ?? claimDenial;
      // A denial code means the part not paid was denied: denied = net - paid (never negative). Without a code, nothing is
      // called denied, so an unexplained shortfall stays a short payment for a person to look at.
      const n = net === null ? null : num(net);
      const p = num(paid);
      const denied =
        denial && typeof n === "number" && typeof p === "number" && p >= 0
          ? String(Math.max(0, cents(n) - cents(p)) / 100)
          : "";
      rows.push([
        ref,
        textOf(claim, up(REMITTANCE_XML.claimFields.paid_on)) ?? "",
        textOf(claim, up(REMITTANCE_XML.claimFields.payer_id)) ?? "",
        invoice,
        code,
        textOf(act, up(af.quantity)) ?? "",
        net ?? "",
        paid,
        denied,
        denial ?? "",
      ]);
      if (rows.length - 1 > MAX_REMITTANCE_ROWS) throw new RemittanceFileError("too_many_rows");
    }
  }
  return rows;
}
