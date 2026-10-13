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
import { CONTROL_LABELS, flattenTree, NATURE_LABELS } from "@/lib/accounting/accounts";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { AccountActiveButton, AccountButton, DeleteAccountButton } from "./forms";

export const metadata = { title: "Chart of accounts" };
export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  const member = await requireMember();
  if (!canAny(member, ["accounting.view", "accounting.coa.manage"]))
    throw new ForbiddenError("accounting.view");
  const manage = can(member, "accounting.coa.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const accounts = await loadAccounts(admin, member.orgId);
  const tree = flattenTree(accounts);
  const used = new Set<string>();
  if (manage) {
    // which ledgers already have lines (they are deactivated, never deleted)
    const { data } = await admin
      .from("acc_journal_lines")
      .select("account_id")
      .eq("org_id", member.orgId)
      .limit(20000);
    for (const l of data ?? []) used.add(l.account_id);
  }
  const groups = tree
    .filter((a) => a.is_group)
    .map((a) => ({ id: a.id, label: `${"  ".repeat(a.depth)}${a.name} (${a.code})` }));
  const hasChildren = new Set(accounts.map((a) => a.parent_id).filter(Boolean));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Chart of accounts"
        description="Tally's predefined groups (marked Tally) and the clinic's ledgers. Accounts are shared by every entity. A ledger with postings is deactivated, never deleted."
      >
        {manage && <AccountButton groups={groups} />}
      </PageHeader>
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Nature</TableHead>
                <TableHead>Control</TableHead>
                <TableHead>Tally group</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tree.map((a) => (
                <TableRow key={a.id} className={a.is_active ? "" : "opacity-60"}>
                  <TableCell className="font-mono text-xs whitespace-nowrap">{a.code}</TableCell>
                  <TableCell>
                    <span
                      style={{ paddingLeft: `${a.depth * 1.25}rem` }}
                      className={a.is_group ? "font-medium" : ""}
                    >
                      {a.name}
                    </span>
                    {a.is_system && (
                      <Badge variant="outline" className="ml-2">
                        Tally
                      </Badge>
                    )}
                    {a.affects_gross_profit && a.is_group && a.depth === 0 && (
                      <Badge variant="outline" className="ml-2">
                        Gross profit
                      </Badge>
                    )}
                    {!a.is_active && (
                      <Badge variant="secondary" className="ml-2">
                        inactive
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{NATURE_LABELS[a.nature]}</TableCell>
                  <TableCell>{a.control ? CONTROL_LABELS[a.control] : ""}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {a.tally_group ?? ""}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {manage && (
                      <>
                        <AccountButton
                          groups={groups}
                          account={{
                            id: a.id,
                            parent_id: a.parent_id,
                            code: a.code,
                            name: a.name,
                            is_group: a.is_group,
                            is_system: a.is_system,
                            is_active: a.is_active,
                            control: a.control,
                            allow_manual: a.allow_manual,
                            currency: a.currency,
                            description: a.description,
                          }}
                        />
                        {!a.is_system && <AccountActiveButton id={a.id} active={a.is_active} />}
                        {!a.is_system && !used.has(a.id) && !hasChildren.has(a.id) && (
                          <DeleteAccountButton id={a.id} />
                        )}
                      </>
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
