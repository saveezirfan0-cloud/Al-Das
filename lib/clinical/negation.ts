/**
 * R-03: negation scrubbing of narrative notes. A clause governed by a negation cue is removed from
 * the cue to the next boundary (. ; , newline, " but ", " however "), so "denies chest pain, no
 * shortness of breath" scrubs to nothing while "chest pain on exertion, denies syncope" keeps its
 * first clause. Known limitation (spec): a cue at the start of a clause drops the whole clause, so
 * "not feeling well with chest pain" is removed. The cue list is a clinical setting (negation_cues).
 */
export const SCRUB_VERSION = 1;

const BOUNDARY = /[.;,\n]+|\s+but\s+|\s+however\s+/i;

function cueRegex(cue: string): RegExp {
  const key = cue.trim().toLowerCase();
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const start = /^[a-z0-9]/.test(key) ? "(?<![a-z0-9])" : "";
  const end = /[a-z0-9]$/.test(key) ? "(?![a-z0-9])" : "";
  return new RegExp(start + escaped + end, "i");
}

export function scrubNarrative(raw: string | null | undefined, cues: readonly string[]): string {
  const patterns = cues.map(cueRegex);
  const kept: string[] = [];
  for (const clause of (raw ?? "").split(BOUNDARY)) {
    let end = clause.length;
    for (const re of patterns) {
      const m = re.exec(clause);
      if (m && m.index < end) end = m.index;
    }
    const left = clause.slice(0, end).trim();
    if (left) kept.push(left);
  }
  return kept.join(", ");
}

/** The composite the live Make sync builds (R-03; whether to add more fields is OQ-28). */
export function composeObservationNotes(parts: {
  complaints?: string | null;
  hpi?: string | null;
  doctorNotes?: string | null;
  nurseNotes?: string | null;
}): string {
  return [parts.complaints, parts.hpi, parts.doctorNotes, parts.nurseNotes]
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join(" ");
}
