import "server-only";

import { can, type MemberLike } from "@/lib/auth/can";
import { readDocumentSettings } from "@/lib/documents/settings";
import {
  consentCheck,
  eligibilityCheck,
  insuranceCheck,
  notCheckedLines,
  unavailableReason,
  type CardDoc,
  type CheckLine,
  type EligibilityRow,
  type EsignRow,
} from "@/lib/front-desk/arrival-check";
import { isEnabled } from "@/lib/integrations/accounts";
import type { AdminClient } from "@/lib/supabase/admin";

type Member = MemberLike & { org: { settings: unknown } };

/**
 * The arrival check lines for a set of appointments (appointment id → lines). Each section reads only with its own
 * permission and switch; a section that is off, refused or unreadable says "Not checked". Patient document titles are
 * never selected (expiry, status and scan state only); e-signature rows give status and time only.
 */
export async function loadArrivalChecks(
  admin: AdminClient,
  member: Member,
  appointments: ReadonlyArray<{ id: string; contact_id: string | null }>,
  today: string,
): Promise<Record<string, CheckLine[]>> {
  const contactIds = [
    ...new Set(appointments.map((a) => a.contact_id).filter((c): c is string => !!c)),
  ];
  const docSettings = readDocumentSettings(member.org.settings);
  const canDocs = can(member, "documents.view");
  const canElig = can(member, "finance.eligibility.manage");
  const docsWhy = unavailableReason({
    featureOn: docSettings.enabled,
    featureName: "patient documents",
    permitted: canDocs,
  });
  const esignOn =
    docSettings.enabled && canDocs && contactIds.length > 0
      ? await isEnabled(admin, member.orgId, "esign").catch(() => false)
      : false;
  const esignWhy =
    docsWhy ??
    unavailableReason({ featureOn: esignOn, featureName: "e-signature", permitted: true });
  const eligWhy = unavailableReason({
    featureOn: true,
    featureName: "eligibility",
    permitted: canElig,
  });

  const appointmentIds = appointments.map((a) => a.id);
  const [cards, checks, requests] = await Promise.all([
    !docsWhy && contactIds.length
      ? admin
          .from("patient_documents")
          .select("contact_id, expires_on, status, scan_status")
          .eq("org_id", member.orgId)
          .eq("category", "insurance_card")
          .in("contact_id", contactIds)
          .limit(500)
      : Promise.resolve({ data: [], error: null }),
    !eligWhy && contactIds.length
      ? admin
          .from("fin_eligibility_checks")
          .select("contact_id, appointment_id, status, valid_to, checked_on")
          .eq("org_id", member.orgId)
          .or(
            `contact_id.in.(${contactIds.join(",")}),appointment_id.in.(${appointmentIds.join(",")})`,
          )
          .order("checked_on", { ascending: false })
          .limit(500)
      : Promise.resolve({ data: [], error: null }),
    !esignWhy && contactIds.length
      ? admin
          .from("esign_requests")
          .select("contact_id, status, created_at")
          .eq("org_id", member.orgId)
          .in("contact_id", contactIds)
          .limit(500)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const cardRows = cards.error
    ? null
    : ((cards.data ?? []) as Array<CardDoc & { contact_id: string }>);
  const checkRows = checks.error
    ? null
    : ((checks.data ?? []) as Array<
        EligibilityRow & { contact_id: string | null; appointment_id: string | null }
      >);
  const esignRows = requests.error
    ? null
    : ((requests.data ?? []) as Array<EsignRow & { contact_id: string }>);

  const out: Record<string, CheckLine[]> = {};
  for (const a of appointments) {
    if (!a.contact_id) {
      out[a.id] = notCheckedLines("no patient record");
      continue;
    }
    out[a.id] = [
      insuranceCheck({
        available: !docsWhy,
        why: docsWhy,
        cards: cardRows ? cardRows.filter((c) => c.contact_id === a.contact_id) : null,
        today,
        leadDays: docSettings.expiry_lead_days,
      }),
      eligibilityCheck({
        available: !eligWhy,
        why: eligWhy,
        checks: checkRows
          ? checkRows.filter((c) => c.contact_id === a.contact_id || c.appointment_id === a.id)
          : null,
        today,
      }),
      consentCheck({
        available: !esignWhy,
        why: esignWhy,
        requests: esignRows ? esignRows.filter((r) => r.contact_id === a.contact_id) : null,
      }),
    ];
  }
  return out;
}
