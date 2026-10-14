import { centsToAmount } from "./amounts";
import type { TallyParseResult } from "./parse";
import { childrenNamed, decodeTallyBytes, scanTallyXml, textOf, type XNode } from "./xml";

/**
 * Tally's answers to the Tally bridge (22J), read here because this folder is the one place Pulse reads Tally XML.
 *
 *  - An import ("Import Data") answers with counters: <RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED>...<ERRORS>0
 *    </ERRORS><LASTVCHID>123</LASTVCHID></RESPONSE>, sometimes inside ENVELOPE/BODY/DATA/IMPORTRESULT, with <LINEERROR>
 *    text when something is wrong (research addendum A.1; Tally's "Voucher Import Response" note). One voucher per request,
 *    so exactly one of CREATED / ALTERED must be 1 and ERRORS, EXCEPTIONS and LINEERROR must be empty; anything else is a
 *    failure, and an answer without counters is "unreadable" (the bridge then looks the voucher up before sending again).
 *  - The trial balance is a Ledger collection with CLOSINGBALANCE, parsed by parse.ts; trialBalanceRows() turns it into
 *    the rows acc_tally_reconcile compares.
 */

export type ImportResponse = {
  /** Counters were found. */
  readable: boolean;
  created: number;
  altered: number;
  errors: number;
  exceptions: number;
  ignored: number;
  cancelled: number;
  /** Tally's MasterID of the last voucher imported (LASTVCHID). */
  lastVchId: number | null;
  lineErrors: string[];
};

export type ImportVerdict =
  | { outcome: "created" | "altered"; masterId: number | null }
  | { outcome: "failed"; code: "tally_error"; message: string }
  | { outcome: "ambiguous"; code: "unreadable_answer" };

const COUNTERS = new Set(["RESPONSE", "IMPORTRESULT", "LINEERROR"]);
const MAX_LINE_ERRORS = 5;

function intIn(node: XNode, name: string): number | null {
  const t = textOf(node, name);
  return t !== null && /^-?\d{1,15}$/.test(t) ? Number(t) : null;
}

function collectLineErrors(node: XNode, out: string[]) {
  if (node.name === "LINEERROR") {
    const t = node.text.replace(/\s+/g, " ").trim();
    if (t) out.push(t.slice(0, 300));
  }
  for (const c of node.children) collectLineErrors(c, out);
}

/** The counters of an import answer (bytes as Tally sent them: UTF-8 or UTF-16). */
export function parseImportResponse(bytes: Uint8Array): ImportResponse {
  const out: ImportResponse = {
    readable: false,
    created: 0,
    altered: 0,
    errors: 0,
    exceptions: 0,
    ignored: 0,
    cancelled: 0,
    lastVchId: null,
    lineErrors: [],
  };
  let text: string;
  try {
    text = decodeTallyBytes(bytes).text;
  } catch {
    return out;
  }
  if (!text.trim().startsWith("<")) return out;
  try {
    scanTallyXml(text, COUNTERS, (node) => {
      const lineErrors: string[] = [];
      collectLineErrors(node, lineErrors);
      out.lineErrors.push(...lineErrors);
      if (node.name === "LINEERROR") return;
      const created = intIn(node, "CREATED");
      const altered = intIn(node, "ALTERED");
      if (created !== null || altered !== null || intIn(node, "ERRORS") !== null)
        out.readable = true;
      out.created += created ?? 0;
      out.altered += altered ?? 0;
      out.errors += intIn(node, "ERRORS") ?? 0;
      out.exceptions += intIn(node, "EXCEPTIONS") ?? 0;
      out.ignored += intIn(node, "IGNORED") ?? 0;
      out.cancelled += intIn(node, "CANCELLED") ?? 0;
      const last = intIn(node, "LASTVCHID");
      if (last !== null && last > 0) out.lastVchId = last;
      // IMPORTRESULT may hold its counters one level down (DATA/IMPORTRESULT/...)
      for (const c of childrenNamed(node, "IMPORTRESULT")) {
        const cc = intIn(c, "CREATED");
        if (cc !== null) {
          out.readable = true;
          out.created += cc;
        }
      }
    });
  } catch {
    return out;
  }
  out.lineErrors = out.lineErrors.slice(0, MAX_LINE_ERRORS);
  return out;
}

/** What one voucher's import answer means. The message is Tally's LINEERROR text (the caller redacts it before storing). */
export function importVerdict(r: ImportResponse): ImportVerdict {
  if (!r.readable && r.lineErrors.length === 0)
    return { outcome: "ambiguous", code: "unreadable_answer" };
  if (r.errors > 0 || r.exceptions > 0 || r.lineErrors.length > 0 || r.created + r.altered !== 1) {
    const message =
      r.lineErrors.join(" | ") ||
      `Tally created ${r.created}, altered ${r.altered}, errors ${r.errors}, exceptions ${r.exceptions}`;
    return { outcome: "failed", code: "tally_error", message: message.slice(0, 300) };
  }
  return { outcome: r.created === 1 ? "created" : "altered", masterId: r.lastVchId };
}

/** Ledger closing balances as trial-balance rows ({name, debit, credit}); ledgers without one or at zero are left out. */
export function trialBalanceRows(
  parsed: Pick<TallyParseResult, "ledgers">,
): Array<{ name: string; debit: number; credit: number }> {
  const rows = new Map<string, { name: string; cents: number }>();
  for (const l of parsed.ledgers) {
    if (l.closingDrMinusCr === null || l.closingDrMinusCr === 0) continue;
    const k = l.name.trim().toLowerCase();
    const r = rows.get(k) ?? { name: l.name.trim(), cents: 0 };
    r.cents += l.closingDrMinusCr;
    rows.set(k, r);
  }
  return [...rows.values()]
    .filter((r) => r.cents !== 0)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((r) => ({
      name: r.name,
      debit: r.cents > 0 ? centsToAmount(r.cents) : 0,
      credit: r.cents < 0 ? centsToAmount(-r.cents) : 0,
    }));
}
