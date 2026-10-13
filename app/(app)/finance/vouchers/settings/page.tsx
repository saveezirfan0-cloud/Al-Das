import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { money } from "@/lib/finance/format";
import { LEDGER_KIND_LABEL, type TallyLedgerKind } from "@/lib/finance/tally-xml";
import { SPECIAL_LABEL, tierProblems } from "@/lib/finance/vouchers";
import { loadPayablesSettings, loadTiers } from "@/lib/finance/vouchers-server";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  ApprovalSettingsForm,
  DeleteLedgerButton,
  LedgerForm,
  TallySettingsForm,
  TierButton,
} from "./forms";

export const metadata = { title: "Voucher settings" };
export const dynamic = "force-dynamic";

export default async function VoucherSettingsPage() {
  const member = await requireMember();
  if (!canAny(member, ["finance.vouchers.settings", "finance.tally.export"]))
    throw new ForbiddenError("finance.vouchers.settings");
  const doa = can(member, "finance.vouchers.settings");
  const tally = can(member, "finance.tally.export");
  const admin = createAdminClient(); // service role AFTER the permission check
  const [tiers, settings, { data: ledgers }, { data: suppliers }] = await Promise.all([
    loadTiers(admin, member.orgId),
    loadPayablesSettings(admin, member.orgId),
    tally
      ? admin
          .from("fin_ref_tally_ledgers")
          .select("kind, key, ledger_name")
          .eq("org_id", member.orgId)
          .order("kind")
          .order("key")
      : Promise.resolve({ data: [] as Array<{ kind: string; key: string; ledger_name: string }> }),
    tally
      ? admin.from("fin_suppliers").select("id, name").eq("org_id", member.orgId)
      : Promise.resolve({ data: [] }),
  ]);
  const problems = tierProblems(tiers);
  const supplierName = new Map((suppliers ?? []).map((s) => [s.id, s.name]));
  const kinds = (Object.keys(LEDGER_KIND_LABEL) as TallyLedgerKind[]).map((k) => ({
    value: k,
    label: LEDGER_KIND_LABEL[k],
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Voucher settings"
        description="The delegation of authority that routes each payment voucher, where vouchers are approved, and how Pulse names things in Tally. Every change is audited."
      />

      {doa && (
        <>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="text-base">Delegation of authority</CardTitle>
              <TierButton />
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-muted-foreground text-sm">
                The Finance Manager verifies every voucher. Each rule adds a department head and /
                or the CEO. Special categories apply at any amount. A change applies to vouchers
                submitted afterwards.
              </p>
              {problems.length > 0 && (
                <ul className="list-disc rounded-md border border-amber-300 bg-amber-50 p-3 pl-6 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Rule</TableHead>
                      <TableHead>Applies to</TableHead>
                      <TableHead>Approvals</TableHead>
                      <TableHead>Bulk</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tiers.map((t) => (
                      <TableRow key={t.code} className={t.active ? "" : "opacity-60"}>
                        <TableCell>
                          <span className="font-mono text-xs">{t.code}</span> {t.label}
                          {t.description && (
                            <p className="text-muted-foreground text-xs">{t.description}</p>
                          )}
                        </TableCell>
                        <TableCell className="text-sm whitespace-nowrap">
                          {t.specialCategory
                            ? `${SPECIAL_LABEL[t.specialCategory]}, any amount`
                            : `AED ${money(t.minAmount)} to ${t.maxAmount === null ? "no limit" : money(t.maxAmount)}`}
                        </TableCell>
                        <TableCell className="text-sm">
                          Finance Manager{t.needsDeptHead ? ", department head" : ""}
                          {t.needsCeo ? ", CEO" : ""}
                        </TableCell>
                        <TableCell>
                          {t.bulkAllowed ? <Badge variant="secondary">bulk</Badge> : "-"}
                        </TableCell>
                        <TableCell className="text-right">
                          <TierButton tier={t} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Approval mode and report thresholds</CardTitle>
            </CardHeader>
            <CardContent>
              <ApprovalSettingsForm
                mode={settings.approvalMode}
                duplicateWindowDays={settings.duplicateWindowDays}
                mismatchTolerance={settings.mismatchTolerance}
                largeAmount={settings.largeAmount}
              />
            </CardContent>
          </Card>
        </>
      )}

      {tally && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Tally ledgers</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="text-muted-foreground text-sm">
                Every expense category, supplier, pay-from account and branch that appears in an
                export needs a Tally ledger (or cost centre) name, spelt exactly as in Tally. The
                export refuses while anything is unmapped.
              </p>
              <LedgerForm kinds={kinds} />
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>What</TableHead>
                      <TableHead>Pulse value</TableHead>
                      <TableHead>Tally ledger</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(ledgers ?? []).length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} className="text-muted-foreground text-sm">
                          Nothing mapped yet.
                        </TableCell>
                      </TableRow>
                    ) : (
                      (ledgers ?? []).map((l) => (
                        <TableRow key={`${l.kind}|${l.key}`}>
                          <TableCell>
                            {LEDGER_KIND_LABEL[l.kind as TallyLedgerKind] ?? l.kind}
                          </TableCell>
                          <TableCell className="text-sm">
                            {l.kind === "supplier" ? (supplierName.get(l.key) ?? l.key) : l.key}
                          </TableCell>
                          <TableCell>{l.ledger_name}</TableCell>
                          <TableCell className="text-right">
                            <DeleteLedgerButton kind={l.kind} keyValue={l.key} />
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
              {(suppliers ?? []).length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer">Supplier ids (to map a supplier)</summary>
                  <ul className="mt-2 flex flex-col gap-1">
                    {(suppliers ?? []).map((s) => (
                      <li key={s.id}>
                        {s.name}: <span className="font-mono text-xs select-all">{s.id}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Tally company</CardTitle>
            </CardHeader>
            <CardContent>
              <TallySettingsForm
                company={settings.tallyCompany}
                costCategory={settings.tallyCostCategory}
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
