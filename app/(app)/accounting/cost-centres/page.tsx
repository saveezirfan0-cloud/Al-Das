import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { CostCentreButton } from "./forms";

export const metadata = { title: "Cost centres" };
export const dynamic = "force-dynamic";

export default async function CostCentresPage() {
  const member = await requireMember();
  if (!canAny(member, ["accounting.coa.manage", "accounting.view"]))
    throw new ForbiddenError("accounting.view");
  const manage = can(member, "accounting.coa.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const { data } = await admin
    .from("acc_cost_centres")
    .select("id, code, name, active")
    .eq("org_id", member.orgId)
    .order("code");
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Cost centres"
        description="Free cost centres on top of the fixed dimensions (branch, department, doctor). Deactivate one you no longer use."
      >
        {manage && <CostCentreButton />}
      </PageHeader>
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-muted-foreground text-sm">
                    No cost centres yet.
                  </TableCell>
                </TableRow>
              )}
              {(data ?? []).map((c) => (
                <TableRow key={c.id} className={c.active ? "" : "opacity-60"}>
                  <TableCell className="font-mono text-xs">{c.code}</TableCell>
                  <TableCell>
                    {c.name}
                    {!c.active && (
                      <Badge variant="secondary" className="ml-2">
                        inactive
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {manage && <CostCentreButton centre={c} />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
