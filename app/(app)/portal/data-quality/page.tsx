import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Data quality" };

const LIMIT = 300;

/**
 * Portal → Data quality (replaces the Acute base's "Data Quality Exceptions" view, R-08): visits whose vitals are
 * incomplete or that have no matched patient, and diagnosis codes that are not in the Diagnosis reference.
 * Read-only. Missing vitals are never read as normal: the rules simply cannot fire on them.
 */
export default async function DataQualityPage() {
  const member = await requirePerm("portal.clinical_visits.read");
  const admin = createAdminClient();
  const showNames = can(member, "contacts.view");

  const [{ data: visits, count }, { data: unknownCodes }] = await Promise.all([
    admin
      .from("v_visit_data_quality")
      .select(
        "visit_id, external_id, visit_date, contact_id, doctor_name, source, missing_temp, missing_bp, missing_spo2, missing_pulse, unmatched_patient",
        { count: "exact" },
      )
      .eq("org_id", member.orgId)
      .eq("is_test_record", false)
      .order("visit_date", { ascending: false })
      .limit(LIMIT),
    admin
      .from("v_unknown_diagnosis_codes")
      .select("diagnosis_code, visit_count, first_seen, last_seen")
      .eq("org_id", member.orgId)
      .order("visit_count", { ascending: false })
      .limit(100),
  ]);
  const rows = visits ?? [];
  const contactIds = [...new Set(rows.map((r) => r.contact_id).filter((x): x is string => !!x))];
  const { data: contacts } =
    showNames && contactIds.length
      ? await admin
          .from("contacts")
          .select("id, full_name")
          .eq("org_id", member.orgId)
          .in("id", contactIds)
      : { data: [] as Array<{ id: string; full_name: string | null }> };
  const nameById = new Map((contacts ?? []).map((c) => [c.id, c.full_name]));

  await recordAccess(admin, member, {
    entity: "portal_record",
    action: "list",
    detail: { screen: "data_quality", rows: rows.length },
  });

  const vitals = rows.filter(
    (r) => r.missing_temp || r.missing_bp || r.missing_spo2 || r.missing_pulse,
  ).length;
  const unmatched = rows.filter((r) => r.unmatched_patient).length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Data quality"
        description="Visits the clinical rules cannot judge properly: missing vitals, no matched patient, or a diagnosis code Pulse does not know."
      />
      <Alert>
        <AlertTitle>Missing is never treated as normal</AlertTitle>
        <AlertDescription>
          A blank temperature, blood pressure, oxygen or pulse never counts as a normal reading, so
          the rules that need it do not fire for that visit. Correct the record in Unite; the next
          sync updates it here.
        </AlertDescription>
      </Alert>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>Visits listed</CardDescription>
            <CardTitle className="text-2xl">{count ?? rows.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Incomplete vitals (shown)</CardDescription>
            <CardTitle className="text-2xl">{vitals}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>No matched patient (shown)</CardDescription>
            <CardTitle className="text-2xl">{unmatched}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <section aria-labelledby="dq-visits" className="flex flex-col gap-2">
        <h2 id="dq-visits" className="text-sm font-semibold">
          Visits{(count ?? 0) > LIMIT ? ` (newest ${LIMIT} of ${count})` : ""}
        </h2>
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No visit has missing data. Nothing to fix.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Visit date</TableHead>
                  <TableHead>Visit reference</TableHead>
                  <TableHead>Doctor</TableHead>
                  {showNames && <TableHead>Patient</TableHead>}
                  <TableHead>What is missing</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.visit_id ?? r.external_id}>
                    <TableCell className="whitespace-nowrap">{r.visit_date}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {r.external_id}
                      {r.source && r.source !== "unite" && (
                        <span className="text-muted-foreground ml-1">({r.source})</span>
                      )}
                    </TableCell>
                    <TableCell>{r.doctor_name ?? "—"}</TableCell>
                    {showNames && (
                      <TableCell>
                        {r.contact_id ? (nameById.get(r.contact_id) ?? "Linked") : "—"}
                      </TableCell>
                    )}
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {r.missing_temp && <Badge variant="outline">Temperature</Badge>}
                        {r.missing_bp && <Badge variant="outline">Blood pressure</Badge>}
                        {r.missing_spo2 && <Badge variant="outline">Oxygen saturation</Badge>}
                        {r.missing_pulse && <Badge variant="outline">Pulse</Badge>}
                        {r.unmatched_patient && <Badge variant="warning">No matched patient</Badge>}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <p className="text-muted-foreground text-xs">
          A visit with no matched patient waits in Portal → Sync review until someone links it.
        </p>
      </section>

      <section aria-labelledby="dq-codes" className="flex flex-col gap-2">
        <h2 id="dq-codes" className="text-sm font-semibold">
          Diagnosis codes not in the reference
        </h2>
        <Card>
          <CardContent className="pt-6">
            {(unknownCodes ?? []).length === 0 ? (
              <p className="text-muted-foreground text-sm">
                Every diagnosis code on a visit is in the Diagnosis reference.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead className="text-right">Visits</TableHead>
                      <TableHead>First seen</TableHead>
                      <TableHead>Last seen</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(unknownCodes ?? []).map((c) => (
                      <TableRow key={c.diagnosis_code ?? ""}>
                        <TableCell className="font-mono">{c.diagnosis_code}</TableCell>
                        <TableCell className="text-right">{c.visit_count}</TableCell>
                        <TableCell>{c.first_seen}</TableCell>
                        <TableCell>{c.last_seen}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <p className="text-muted-foreground mt-3 text-xs">
              An unknown code never makes a condition chronic. Add it to Portal → Diagnoses
              (ICD-10), with its chronic flag and condition group; visits are linked to it the
              following night.
            </p>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
