import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
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
import { requireMember, requirePerm } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { UniteReportFlow, type RecentReportUpload } from "./unite-report-flow";
import { UploadFlow } from "./upload-flow";

export const metadata = { title: "Uploads" };
export const dynamic = "force-dynamic";

const VARIANT = { committed: "success", validated: "warning", rejected: "destructive" } as const;

export default async function UploadPage() {
  const member = await requireMember();
  const claims = can(member, "finance.claims.import");
  const revenue = can(member, "finance.revenue.import");
  // either upload opens the page; with neither this refuses like before
  if (!claims && !revenue) await requirePerm("finance.claims.import");
  const admin = createAdminClient();
  const [{ data: files }, recent] = await Promise.all([
    claims
      ? admin
          .from("fin_raw_diligence_files")
          .select(
            "id, file_name, status, uploaded_at, row_count, sum_net, sum_remitted, sum_rejected, commit_summary",
          )
          .eq("org_id", member.orgId)
          .order("uploaded_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: [] }),
    revenue ? recentReportUploads(admin, member.orgId) : Promise.resolve([]),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Uploads"
        description={
          claims && revenue
            ? "Upload the Diligence claims report weekly and at month end, and the Unite collection report."
            : claims
              ? "Upload the Diligence claims report weekly and at month end."
              : "Upload the Unite collection report."
        }
      />
      {claims && <DiligenceSection files={files ?? []} />}
      {revenue && <UniteReportFlow recent={recent} />}
    </div>
  );
}

/** Latest Unite collection report uploads (dates, status, counts and who; never a row). */
async function recentReportUploads(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
): Promise<RecentReportUpload[]> {
  const { data } = await admin
    .from("fin_report_uploads")
    .select(
      "id, from_date, to_date, status, row_count, reconciled, created_by, created_at, committed_by, committed_at",
    )
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(20);
  const rows = data ?? [];
  const people = [
    ...new Set(rows.flatMap((r) => [r.created_by, r.committed_by]).filter((x): x is string => !!x)),
  ];
  const { data: profiles } = people.length
    ? await admin.from("profiles").select("id, first_name, last_name").in("id", people)
    : { data: [] };
  const nameOf = (uid: string | null) => {
    if (!uid) return "";
    const p = (profiles ?? []).find((x) => x.id === uid);
    return p
      ? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() || "a team member"
      : "a team member";
  };
  return rows.map((r) => ({
    id: r.id,
    fromDate: r.from_date,
    toDate: r.to_date,
    status: r.status,
    rowCount: r.row_count,
    reconciled: r.reconciled,
    createdBy: nameOf(r.created_by),
    createdAt: r.created_at,
    committedBy: nameOf(r.committed_by),
    committedAt: r.committed_at,
  }));
}

type DiligenceFile = {
  id: string;
  file_name: string | null;
  status: string;
  uploaded_at: string;
  row_count: number | null;
  sum_net: number | null;
  sum_remitted: number | null;
  sum_rejected: number | null;
};

function DiligenceSection({ files }: { files: DiligenceFile[] }) {
  return (
    <>
      <UploadFlow />
      <Card>
        <CardHeader>
          <CardTitle>Previous uploads</CardTitle>
          <CardDescription>Latest 20.</CardDescription>
        </CardHeader>
        <CardContent>
          {(files ?? []).length === 0 ? (
            <EmptyState
              title="Nothing uploaded yet"
              description="Upload the Diligence claim file above; Pulse keeps only the sanitised rows."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Uploaded</TableHead>
                  <TableHead>File</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                  <TableHead className="text-right">Remitted</TableHead>
                  <TableHead className="text-right">Rejected</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {files.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell className="text-xs">
                      {new Date(f.uploaded_at).toLocaleString()}
                    </TableCell>
                    <TableCell className="max-w-56 truncate text-xs">{f.file_name}</TableCell>
                    <TableCell>
                      <Badge variant={VARIANT[f.status as keyof typeof VARIANT] ?? "secondary"}>
                        {f.status === "validated" ? "awaiting confirmation" : f.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{f.row_count ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {f.sum_net?.toLocaleString() ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {f.sum_remitted?.toLocaleString() ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {f.sum_rejected?.toLocaleString() ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
