import Link from "next/link";

import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { loadAccounts, peopleNames } from "@/lib/accounting/accounting-server";
import { METHOD_LABELS } from "@/lib/accounting/assets/depreciation";
import { registerAt, type RegisterTotal } from "@/lib/accounting/assets/register";
import {
  loadAssetClasses,
  loadAssets,
  loadBranchCodes,
  loadInvoiceOptions,
  loadPostedLines,
} from "@/lib/accounting/assets/server";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { money } from "@/lib/finance/format";
import { createAdminClient } from "@/lib/supabase/admin";

import { dateParam } from "../ui";
import {
  AssetButton,
  ClassButton,
  DeleteAssetButton,
  DisposeButton,
  PostDisposalButton,
  WithdrawDisposalButton,
} from "./forms";

export const metadata = { title: "Fixed assets" };
export const dynamic = "force-dynamic";

const VIEW = [
  "accounting.assets.manage",
  "accounting.journals.approve",
  "accounting.reports.view",
  "accounting.view",
];

export default async function FixedAssetsPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string }>;
}) {
  const member = await requireMember();
  if (!canAny(member, VIEW)) throw new ForbiddenError("accounting.view");
  const manage = can(member, "accounting.assets.manage");
  const approve = can(member, "accounting.journals.approve");
  const today = todayIn(member.org.timezone);
  const asOf = dateParam((await searchParams).asOf, today);
  const admin = createAdminClient(); // service role AFTER the permission check
  const [assets, classes, posted, branches, invoices, accounts] = await Promise.all([
    loadAssets(admin, member.orgId),
    loadAssetClasses(admin, member.orgId),
    loadPostedLines(admin, member.orgId, { kinds: ["depreciation"] }),
    loadBranchCodes(admin, member.orgId),
    manage ? loadInvoiceOptions(admin, member.orgId) : Promise.resolve([]),
    loadAccounts(admin, member.orgId),
  ]);
  const register = registerAt(assets, posted, asOf);
  const pending = assets.filter(
    (a) => a.disposalStatus === "prepared" || a.disposalStatus === "waiting_ledger_start",
  );
  const people = await peopleNames(
    admin,
    pending.map((a) => a.disposalPreparedBy),
  );
  const ledgers = accounts
    .filter((a) => !a.is_group && a.is_active)
    .map((a) => ({ id: a.id, code: a.code, name: a.name, nature: a.nature }));
  const postedAssets = new Set(posted.map((l) => l.ref));
  const byId = new Map(assets.map((a) => [a.id, a]));
  const invoiceChoices = invoices.map((i) => ({
    id: i.id,
    label: i.label,
    left: Math.max(0, Math.round((i.net - i.capitalised) * 100) / 100),
  }));

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Fixed assets"
        description="The register at a date, from posted depreciation: cost, accumulated depreciation and net book value per asset, class and branch. Depreciation is monthly from the month an asset goes into service."
      >
        <Button asChild variant="outline" size="sm">
          <a href={`/api/accounting/assets?asOf=${asOf}`}>Download Excel</a>
        </Button>
        {manage && <AssetButton classes={classes} branches={branches} invoices={invoiceChoices} />}
      </PageHeader>

      <form className="flex flex-wrap items-end gap-2" method="get">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">As at</span>
          <Input type="date" name="asOf" defaultValue={asOf} className="w-40" />
        </label>
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>

      {pending.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Disposals waiting to post</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            {pending.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-xs">{a.code}</span>
                <span>
                  {a.disposalDate}, proceeds {money(a.disposalProceeds ?? 0)}, net book value{" "}
                  {money(a.cost - (a.disposalAccumulated ?? 0))}
                </span>
                <span className="text-muted-foreground text-xs">
                  prepared by{" "}
                  {a.disposalPreparedBy
                    ? (people.get(a.disposalPreparedBy) ?? "a member")
                    : "a member"}
                </span>
                {a.disposalStatus === "waiting_ledger_start" && (
                  <Badge variant="warning">Waiting for the ledger start date</Badge>
                )}
                {approve && a.disposalSha256 && a.disposalPreparedBy !== member.userId && (
                  <PostDisposalButton id={a.id} hash={a.disposalSha256} code={a.code} />
                )}
                {manage && a.disposalStatus === "prepared" && <WithdrawDisposalButton id={a.id} />}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <TotalsCard title="By class" rows={register.byClass} total={register.total} />
        <TotalsCard title="By branch" rows={register.byBranch} total={register.total} />
      </div>

      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Code</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Class</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>In service</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Accumulated</TableHead>
                <TableHead className="text-right">Net book value</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {register.lines.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9}>
                    <EmptyState title="No assets at this date" className="border-0 p-6" />
                  </TableCell>
                </TableRow>
              )}
              {register.lines.map((l) => {
                const a = byId.get(l.id)!;
                return (
                  <TableRow key={l.id}>
                    <TableCell className="font-mono text-xs">{l.code}</TableCell>
                    <TableCell>
                      {l.description}
                      {l.status === "fully_depreciated" && (
                        <Badge variant="secondary" className="ml-2">
                          fully depreciated
                        </Badge>
                      )}
                      {l.status === "disposed" && (
                        <Badge variant="secondary" className="ml-2">
                          disposed {l.disposalDate}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {l.className}
                      <div className="text-muted-foreground text-xs">
                        {METHOD_LABELS[a.method]}, {a.lifeMonths} months
                      </div>
                    </TableCell>
                    <TableCell>{l.branchCode ?? ""}</TableCell>
                    <TableCell className="text-sm">{l.inServiceDate}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(l.cost)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {money(l.accumulated)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(l.nbv)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {manage && a.status !== "disposed" && a.disposalStatus === null && (
                        <>
                          <AssetButton
                            asset={{ ...a, locked: postedAssets.has(a.id) }}
                            classes={classes}
                            branches={branches}
                            invoices={invoiceChoices}
                          />
                          <DisposeButton id={a.id} code={a.code} today={today} ledgers={ledgers} />
                          {!postedAssets.has(a.id) && <DeleteAssetButton id={a.id} code={a.code} />}
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {register.lines.length > 0 && (
                <TableRow className="font-medium">
                  <TableCell colSpan={5}>Total ({register.total.count})</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(register.total.cost)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(register.total.accumulated)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {money(register.total.nbv)}
                  </TableCell>
                  <TableCell />
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Asset classes</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Class</TableHead>
                <TableHead>Method</TableHead>
                <TableHead className="text-right">Life</TableHead>
                <TableHead className="text-right">Residual</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {classes.map((c) => (
                <TableRow key={c.id} className={c.active ? "" : "opacity-60"}>
                  <TableCell>{c.name}</TableCell>
                  <TableCell>{METHOD_LABELS[c.method]}</TableCell>
                  <TableCell className="text-right">{c.life_months} months</TableCell>
                  <TableCell className="text-right">{c.residual_pct}%</TableCell>
                  <TableCell className="text-right">
                    {manage && <ClassButton cls={c} ledgers={ledgers} />}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-muted-foreground mt-3 text-xs">
            Leasehold improvements: use the shorter of 60 months and the remaining lease term.
            Leases themselves (IFRS 16 right-of-use assets and lease liabilities) are not handled
            yet, pending the reporting framework decision (OQ-125); enter a lease as a prepayment or
            accrual on the{" "}
            <Link href="/accounting/schedules" className="underline">
              Schedules
            </Link>{" "}
            page meanwhile.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function TotalsCard({
  title,
  rows,
  total,
}: {
  title: string;
  rows: RegisterTotal[];
  total: RegisterTotal;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead />
              <TableHead className="text-right">Cost</TableHead>
              <TableHead className="text-right">Accumulated</TableHead>
              <TableHead className="text-right">NBV</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell>
                  {r.label} <span className="text-muted-foreground text-xs">({r.count})</span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{money(r.cost)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(r.accumulated)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(r.nbv)}</TableCell>
              </TableRow>
            ))}
            <TableRow className="font-medium">
              <TableCell>Total</TableCell>
              <TableCell className="text-right tabular-nums">{money(total.cost)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(total.accumulated)}</TableCell>
              <TableCell className="text-right tabular-nums">{money(total.nbv)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
