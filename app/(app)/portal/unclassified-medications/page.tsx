import { CappedNote } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { suggestMedicationClass } from "@/lib/clinical/medication-class";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

import { ClassifyList, type UnclassifiedRow } from "./classify-list";

export const metadata = { title: "Unclassified medications" };

/**
 * Portal → Unclassified medications (R-05, TP-19): Unite medication codes on prescriptions that have no class in
 * the Medication classes reference. They fail closed (no antibiotic sequence, no GP-05 medication rule) until a
 * clinician classifies them here. The old Make heuristic is shown as a suggestion only.
 */
export default async function UnclassifiedMedicationsPage() {
  const member = await requirePerm("portal.clinical_visits.read");
  const admin = createAdminClient();

  const { data } = await admin
    .from("v_unclassified_medications")
    .select("medication_code, medication_name, prescription_count, first_seen, last_seen")
    .eq("org_id", member.orgId)
    .not("medication_code", "is", null)
    .order("prescription_count", { ascending: false })
    .limit(500);
  const rows = data ?? [];
  const codes = rows.map((r) => r.medication_code).filter((c): c is string => !!c);
  const { data: refs } = codes.length
    ? await admin
        .from("ref_medications")
        .select("ddc_code, medicine_type, all_medicine_types")
        .eq("org_id", member.orgId)
        .in("ddc_code", codes)
    : {
        data: [] as Array<{
          ddc_code: string;
          medicine_type: string | null;
          all_medicine_types: string[] | null;
        }>,
      };
  const refByCode = new Map((refs ?? []).map((r) => [r.ddc_code, r]));

  await recordAccess(admin, member, {
    entity: "portal_record",
    action: "list",
    detail: { screen: "unclassified_medications", rows: rows.length },
  });

  const items: UnclassifiedRow[] = rows.map((r) => {
    const ref = r.medication_code ? refByCode.get(r.medication_code) : undefined;
    return {
      code: r.medication_code ?? "",
      name: r.medication_name,
      prescriptions: Number(r.prescription_count ?? 0),
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      medicineType: ref?.medicine_type ?? null,
      suggestion: suggestMedicationClass(ref?.medicine_type, ref?.all_medicine_types),
    };
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Unclassified medications"
        description="Medication codes from Unite that have no class yet. Until a clinician classifies a code, no antibiotic sequence or medication rule uses it."
      />
      <Alert>
        <AlertTitle>The suggestion is only a hint</AlertTitle>
        <AlertDescription>
          It repeats how the old Make scenario guessed from the Unite medicine type, which can be
          wrong (a combination drug, a missing type). Check the drug before you save. Saving moves
          this code&apos;s unclassified prescriptions to the class you chose and is recorded in the
          audit log.
        </AlertDescription>
      </Alert>
      <ClassifyList items={items} canWrite={can(member, "portal.medication_classes.write")} />
      {rows.length >= 500 && <CappedNote shown={500} />}
    </div>
  );
}
