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
import { loadAccounts } from "@/lib/accounting/accounting-server";
import { postableAccounts } from "@/lib/accounting/accounts";
import { TAX_KIND_LABELS, type TaxKind } from "@/lib/accounting/tax";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { TaxCodeButton } from "./forms";

export const metadata = { title: "Tax codes" };
export const dynamic = "force-dynamic";

export default async function TaxCodesPage() {
  const member = await requireMember();
  if (!canAny(member, ["accounting.coa.manage", "accounting.tax.manage", "accounting.view"]))
    throw new ForbiddenError("accounting.view");
  const manage = can(member, "accounting.coa.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const [{ data: codes }, accounts] = await Promise.all([
    admin
      .from("acc_tax_codes")
      .select("id, code, name, rate, kind, output_account_id, input_account_id, active")
      .eq("org_id", member.orgId)
      .order("code"),
    loadAccounts(admin, member.orgId),
  ]);
  const label = new Map(accounts.map((a) => [a.id, `${a.code} ${a.name}`]));
  const options = postableAccounts(accounts).map((a) => ({
    id: a.id,
    label: `${a.code} ${a.name}`,
  }));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Tax codes"
        description="UAE VAT: standard 5%, zero-rated, exempt, out of scope, reverse charge and blocked input VAT. Which service is which is for the tax adviser to confirm."
      >
        {manage && <TaxCodeButton accounts={options} />}
      </PageHeader>
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead className="text-right">Rate</TableHead>
                <TableHead>Output VAT</TableHead>
                <TableHead>Input VAT</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(codes ?? []).map((t) => (
                <TableRow key={t.id} className={t.active ? "" : "opacity-60"}>
                  <TableCell className="font-mono text-xs">{t.code}</TableCell>
                  <TableCell>
                    {t.name}
                    {!t.active && (
                      <Badge variant="secondary" className="ml-2">
                        inactive
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{TAX_KIND_LABELS[t.kind as TaxKind] ?? t.kind}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {Number(t.rate).toFixed(2)}%
                  </TableCell>
                  <TableCell className="text-xs">
                    {t.output_account_id ? label.get(t.output_account_id) : "-"}
                  </TableCell>
                  <TableCell className="text-xs">
                    {t.input_account_id ? label.get(t.input_account_id) : "-"}
                  </TableCell>
                  <TableCell className="text-right">
                    {manage && (
                      <TaxCodeButton accounts={options} tax={{ ...t, rate: Number(t.rate) }} />
                    )}
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
