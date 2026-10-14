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
import { CASH_FLOW_LABELS, effectiveCashFlowClasses } from "@/lib/accounting/statements/cash-flow";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  AccountActiveButton,
  AccountButton,
  AccountReportingButton,
  DeleteAccountButton,
} from "./forms";

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
  const cfClass = effectiveCashFlowClasses(accounts);
  const groups = tree
    .filter((a) => a.is_group)
    .map((a) => ({ id: a.id, label: `${"  ".repeat(a.depth)}${a.name} (${a.code})` }));
  const hasChildren = new Set(accounts.map((a) => a.parent_id).filter(Boolean));
  // Which deletable ledgers already have lines (they are deactivated, never deleted). Only accounts that could show a
  // Delete button are checked.
  const used = manage
    ? await accountsWithLines(
        admin,
        member.orgId,
        accounts.filter((a) => !a.is_system && !hasChildren.has(a.id)).map((a) => a.id),
      )
    : new Set<string>();

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
                <TableHead>Cash flow</TableHead>
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
                  <TableCell className="text-muted-foreground text-xs">
                    {(() => {
                      const k = cfClass.get(a.id);
                      return k
                        ? `${CASH_FLOW_LABELS[k]}${a.cash_flow_class ? "" : " (group)"}`
                        : "";
                    })()}
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
                        <AccountReportingButton
                          account={{
                            id: a.id,
                            code: a.code,
                            nature: a.nature,
                            is_group: a.is_group,
                            cash_flow_class: a.cash_flow_class,
                            ct_treatment: a.ct_treatment,
                            requires_branch: a.requires_branch,
                            requires_cost_centre: a.requires_cost_centre,
                          }}
                          effectiveClass={cfClass.get(a.id) ?? null}
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

/**
 * The accounts among `ids` that have at least one journal line. PostgREST returns at most 1,000 rows per request and
 * cannot SELECT DISTINCT, so each chunk is walked in account order and skips past every account it has already seen
 * (`account_id > last`): a busy account costs at most one page instead of all its lines.
 */
async function accountsWithLines(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  ids: string[],
): Promise<Set<string>> {
  const used = new Set<string>();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    let last: string | null = null;
    for (let guard = 0; guard <= chunk.length; guard++) {
      let q = admin
        .from("acc_journal_lines")
        .select("account_id")
        .eq("org_id", orgId)
        .in("account_id", chunk);
      if (last) q = q.gt("account_id", last);
      const { data, error } = await q.order("account_id").limit(1000);
      if (error || !data?.length) break;
      for (const l of data) used.add(l.account_id);
      if (data.length < 1000) break;
      last = data[data.length - 1].account_id;
    }
  }
  return used;
}
