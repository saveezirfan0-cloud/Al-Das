// What the connector accepts from Pulse (pure). A job that is not exactly one of these is refused and reported as
// "refused_job"; nothing else ever reaches Tally. There is no delete job, and an import must be one voucher that Pulse
// itself created (REMOTEID "pulse-..."), sent with ACTION Create or Alter.

import { REMOTE_ID_RE } from "./envelopes.mjs";

export const JOB_TYPES = Object.freeze([
  "export_masters_since",
  "export_vouchers_since",
  "export_trial_balance",
  "import_voucher",
]);

export const MAX_IMPORT_XML = 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isCompany = (c) =>
  typeof c === "string" && c.trim().length > 0 && c.length <= 120 && !/[\u0000-\u001f]/.test(c);
const isAlter = (n) => Number.isSafeInteger(n) && n >= 0;

/** null when the job may run, else the reason it is refused. */
export function checkJob(job) {
  if (!job || typeof job !== "object" || Array.isArray(job)) return "not_an_object";
  if (typeof job.id !== "string" || !UUID.test(job.id)) return "bad_id";
  if (!JOB_TYPES.includes(job.type)) return "unknown_type";
  if (!isCompany(job.company)) return "bad_company";
  switch (job.type) {
    case "export_masters_since":
      return isAlter(job.since_alter_id) ? null : "bad_alter_id";
    case "export_vouchers_since":
      if (!isAlter(job.since_alter_id)) return "bad_alter_id";
      return DAY.test(job.from ?? "") && DAY.test(job.to ?? "") && job.from <= job.to
        ? null
        : "bad_dates";
    case "export_trial_balance":
      return DAY.test(job.as_at ?? "") ? null : "bad_dates";
    case "import_voucher":
      if (typeof job.remote_id !== "string" || !REMOTE_ID_RE.test(job.remote_id))
        return "not_pulse_voucher";
      if (!DAY.test(job.voucher_date ?? "")) return "bad_dates";
      return checkImportXml(job.xml, job.remote_id) ?? checkImportCompany(job.xml, job.company);
    default:
      return "unknown_type";
  }
}

// One connector can serve several Tally companies, so a voucher must name the very company the job is for.
const unescapeXml = (t) =>
  t
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
const squash = (t) => t.replace(/\s+/g, " ").trim();

/** null when the import's SVCURRENTCOMPANY is the job's company, else "wrong_company". */
export function checkImportCompany(xml, company) {
  const named = [...xml.matchAll(/<SVCURRENTCOMPANY>([\s\S]*?)<\/SVCURRENTCOMPANY>/g)];
  return named.length === 1 && squash(unescapeXml(named[0][1])) === squash(company)
    ? null
    : "wrong_company";
}

// Objects other than one VOUCHER must never be in an import from Pulse (masters, companies, TDL code, ...).
const FORBIDDEN_TAGS =
  /<\s*\/?\s*(LEDGER|GROUP|COSTCENTRE|COSTCATEGORY|VOUCHERTYPE|COMPANY|STOCKITEM|STOCKGROUP|STOCKCATEGORY|UNIT|GODOWN|CURRENCY|BUDGET|EMPLOYEE|TDL|TDLMESSAGE|SYSTEM|COLLECTION|OBJECT|FUNCTION|REPORT|FORM|ACTION)\b/i;

/** null when `xml` is one Pulse voucher import for `remoteId`, else the reason it is refused. */
export function checkImportXml(xml, remoteId) {
  if (typeof xml !== "string" || xml.length === 0) return "no_xml";
  if (xml.length > MAX_IMPORT_XML) return "too_large";
  const s = xml.replace(/^﻿/, "").trim();
  if (!s.startsWith("<ENVELOPE>") || !s.endsWith("</ENVELOPE>")) return "not_an_envelope";
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(s)) return "doctype";
  const requests = [...s.matchAll(/<TALLYREQUEST>([\s\S]*?)<\/TALLYREQUEST>/g)];
  if (requests.length !== 1 || requests[0][1].trim() !== "Import Data") return "not_an_import";
  const reports = [...s.matchAll(/<REPORTNAME>([\s\S]*?)<\/REPORTNAME>/g)];
  if (reports.length !== 1 || reports[0][1].trim() !== "Vouchers") return "not_vouchers";
  if (FORBIDDEN_TAGS.test(s)) return "forbidden_object";
  const vouchers = [...s.matchAll(/<VOUCHER(\s[^>]*)?>/g)];
  if (vouchers.length !== 1 || (s.match(/<\/VOUCHER>/g) ?? []).length !== 1)
    return "not_one_voucher";
  const attrs = vouchers[0][1] ?? "";
  const remote = attrs.match(/\bREMOTEID\s*=\s*"([^"]*)"/);
  if (!remote || remote[1] !== remoteId || !REMOTE_ID_RE.test(remote[1]))
    return "not_pulse_voucher";
  const action = attrs.match(/\bACTION\s*=\s*"([^"]*)"/);
  if (!action || !["Create", "Alter"].includes(action[1])) return "bad_action";
  // never a delete, in any spelling
  if (
    /\bACTION\s*=\s*["']?\s*Delete/i.test(s) ||
    /<ISDELETED>\s*Yes/i.test(s) ||
    /<DELETE/i.test(s)
  )
    return "delete";
  for (const g of s.matchAll(/<(GUID|REMOTEID)>([\s\S]*?)<\/\1>/g))
    if (g[2].trim() !== remoteId) return "not_pulse_voucher";
  return null;
}

/** True when Tally's answer to a look-up holds the voucher with this REMOTEID (or GUID). */
export function answerHoldsVoucher(text, remoteId) {
  if (!REMOTE_ID_RE.test(remoteId)) return false;
  return (
    text.includes(`REMOTEID="${remoteId}"`) ||
    text.includes(`<REMOTEID>${remoteId}</REMOTEID>`) ||
    text.includes(`<GUID>${remoteId}</GUID>`)
  );
}

/** Tally's bytes as text (UTF-8, or UTF-16 with or without a byte order mark). */
export function decodeTally(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
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
