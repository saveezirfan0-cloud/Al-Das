import { createHash } from "node:crypto";

import { journalCanonical, type CanonicalJournal } from "@/lib/accounting/canonical";

/** The journal's content fingerprint (server and tests only: node:crypto). Same text as acc_journal_compute_hash(). */
export function journalContentHash(j: CanonicalJournal): string {
  return createHash("sha256").update(journalCanonical(j), "utf8").digest("hex");
}
