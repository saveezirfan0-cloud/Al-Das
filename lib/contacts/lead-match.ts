import { comparePerson, nameTokens } from "@/lib/household/shared-phone";

/**
 * Sanoflow lead to Unite patient matching (docs/45 P4). Pure.
 *
 * A LEAD is a contact with no Unite PIN; a PATIENT has one. The database lists candidate pairs cheaply
 * (public.lead_patient_blocks: the same last nine digits of a phone, or the same name of two or more words); this module
 * decides how sure each pair is and whether a lead points at one patient or at several. Nothing here merges: the result
 * goes to the duplicates panel and a person presses Merge.
 *
 * Rules
 *  - evidence is only used to refuse or to rank; a bare phone number never proves identity (families share numbers);
 *  - a different first name, or a different date of birth, against a patient the clinic identified (PIN) refuses the
 *    pair (the family-aware `comparePerson` the import matcher uses);
 *  - name and date of birth both equal, or a phone AND an equal name, is HIGH;
 *  - a phone alone, when the lead has no name to compare, is MEDIUM; a phone with the same first name but another
 *    surname, or a name alone, is LOW;
 *  - a lead that reaches MEDIUM or better against more than one patient is AMBIGUOUS: every pair is listed and none is
 *    preferred.
 */

export type PersonRef = {
  id: string;
  fullName: string | null;
  dob: string | null;
  /** Primary phone, E.164. */
  phone: string | null;
  /** Alternate phones, E.164. */
  altPhones?: readonly string[];
  /** The Unite PIN: set = patient, blank = lead. */
  externalId: string | null;
};

export type LeadEvidence = "phone_exact" | "phone_national" | "name" | "name_dob";
export type Confidence = "high" | "medium" | "low";

export type LeadPatientPair = {
  leadId: string;
  patientId: string;
  confidence: Confidence;
  evidence: LeadEvidence[];
  /** The lead reaches medium or better against more than one patient: a person must choose. */
  ambiguous: boolean;
};

const RANK: Record<Confidence, number> = { low: 1, medium: 2, high: 3 };

/** The last nine digits of a number (UAE mobiles are nine digits after the country code or the leading 0). */
export function nationalKey(phone: string | null | undefined): string | null {
  const d = (phone ?? "").replace(/\D/g, "");
  return d.length >= 9 ? d.slice(-9) : null;
}

const isPatient = (p: PersonRef) => (p.externalId ?? "").trim() !== "";

function phonesOf(p: PersonRef): string[] {
  return [p.phone, ...(p.altPhones ?? [])].filter((x): x is string => !!x);
}

function sortedName(name: string | null): string {
  return nameTokens(name).slice().sort().join(" ");
}

/** How one lead relates to one patient, or null when there is nothing to go on or the evidence refuses the pair. */
export function comparePair(
  lead: PersonRef,
  patient: PersonRef,
): { confidence: Confidence; evidence: LeadEvidence[] } | null {
  if (isPatient(lead) || !isPatient(patient) || lead.id === patient.id) return null;

  const leadPhones = phonesOf(lead);
  const patientPhones = phonesOf(patient);
  const phoneExact = leadPhones.some((p) => patientPhones.includes(p));
  const leadKeys = new Set(leadPhones.map(nationalKey).filter((k): k is string => !!k));
  const phoneNational =
    !phoneExact &&
    patientPhones.some((p) => (nationalKey(p) ? leadKeys.has(nationalKey(p)!) : false));
  const phone = phoneExact || phoneNational;

  const leadWords = nameTokens(lead.fullName);
  const nameEqual =
    leadWords.length >= 2 && sortedName(lead.fullName) === sortedName(patient.fullName);
  const bothDob = !!(lead.dob && patient.dob);
  if (bothDob && lead.dob !== patient.dob) return null;
  // The same words in another order ("Demo Layla" / "Layla Demo") are the same name; otherwise ask the family-aware rule.
  const likeness = nameEqual
    ? bothDob
      ? "same"
      : "unknown"
    : comparePerson(
        { externalId: null, fullName: lead.fullName, dob: lead.dob },
        {
          id: patient.id,
          fullName: patient.fullName,
          dob: patient.dob,
          externalId: patient.externalId,
          dependant: false,
        },
      );
  if (likeness === "different") return null;

  const evidence: LeadEvidence[] = [];
  if (phoneExact) evidence.push("phone_exact");
  if (phoneNational) evidence.push("phone_national");

  if (likeness === "same") {
    evidence.push("name_dob");
    return { confidence: "high", evidence };
  }
  if (nameEqual) evidence.push("name");

  if (phone && nameEqual) return { confidence: "high", evidence };
  if (phone && leadWords.length === 0) return { confidence: "medium", evidence };
  if (phone) return { confidence: "low", evidence };
  if (nameEqual) return { confidence: "low", evidence };
  return null;
}

/**
 * Decides every lead against the patients it was paired with. `pairs` come from public.lead_patient_blocks; ids that
 * are not in `people` are ignored. A lead with several MEDIUM-or-better patients marks all of those pairs ambiguous.
 * Output order: most sure first, then by ids, so the panel is stable.
 */
export function decideLeadMatches(
  people: readonly PersonRef[],
  pairs: ReadonlyArray<{ leadId: string; patientId: string }>,
): LeadPatientPair[] {
  const byId = new Map(people.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const perLead = new Map<string, LeadPatientPair[]>();
  for (const pair of pairs) {
    const key = `${pair.leadId}|${pair.patientId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const lead = byId.get(pair.leadId);
    const patient = byId.get(pair.patientId);
    if (!lead || !patient) continue;
    const r = comparePair(lead, patient);
    if (!r) continue;
    const list = perLead.get(lead.id) ?? [];
    list.push({
      leadId: lead.id,
      patientId: patient.id,
      confidence: r.confidence,
      evidence: r.evidence,
      ambiguous: false,
    });
    perLead.set(lead.id, list);
  }
  const out: LeadPatientPair[] = [];
  for (const list of perLead.values()) {
    const strong = list.filter((p) => RANK[p.confidence] >= RANK.medium);
    if (strong.length > 1) for (const p of strong) p.ambiguous = true;
    out.push(...list);
  }
  return out.sort(
    (a, b) =>
      RANK[b.confidence] - RANK[a.confidence] ||
      a.leadId.localeCompare(b.leadId) ||
      a.patientId.localeCompare(b.patientId),
  );
}

export const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: "Very likely the same person",
  medium: "Possibly the same person",
  low: "Weak match",
};
