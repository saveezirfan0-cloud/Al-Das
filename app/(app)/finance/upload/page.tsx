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
import { requirePerm } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { UploadFlow } from "./upload-flow";

export const metadata = { title: "Insurance upload" };
export const dynamic = "force-dynamic";

const VARIANT = { committed: "success", validated: "warning", rejected: "destructive" } as const;

export default async function UploadPage() {
  const member = await requirePerm("finance.claims.import");
  const { data: files } = await createAdminClient()
    .from("fin_raw_diligence_files")
    .select(
      "id, file_name, status, uploaded_at, row_count, sum_net, sum_remitted, sum_rejected, commit_summary",
    )
    .eq("org_id", member.orgId)
    .order("uploaded_at", { ascending: false })
    .limit(20);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Insurance upload"
        description="Upload the Diligence claims report weekly and at month end."
      />
      <UploadFlow />
      <Card>
        <CardHeader>
          <CardTitle>Previous uploads</CardTitle>
          <CardDescription>Latest 20.</CardDescription>
        </CardHeader>
        <CardContent>
          {(files ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing uploaded yet.</p>
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
                {(files ?? []).map((f) => (
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
    </div>
  );
}
