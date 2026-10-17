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
import { loadEntities } from "@/lib/accounting/accounting-server";
import { EMIRATES } from "@/lib/accounting/accounts";
import { MONTH_NAMES } from "@/lib/accounting/numbering";
import { resolveCompanies } from "@/lib/accounting/tally/companies";
import { loadCompanyEntities } from "@/lib/accounting/tally/import-server";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { BranchForm, EntityButton, LedgerStartButton } from "./forms";

export const metadata = { title: "Entities and fiscal years" };
export const dynamic = "force-dynamic";

export default async function EntitiesPage() {
  const member = await requireMember();
  if (!canAny(member, ["accounting.settings.manage", "accounting.view"]))
    throw new ForbiddenError("accounting.view");
  const manage = can(member, "accounting.settings.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const [
    entities,
    { data: years },
    { data: branches },
    { data: mapped },
    { data: starts },
    companyView,
  ] = await Promise.all([
    loadEntities(admin, member.orgId),
    admin
      .from("acc_fiscal_years")
      .select("id, entity_id, label, start_date, end_date, status")
      .eq("org_id", member.orgId)
      .order("start_date", { ascending: false }),
    admin.from("fin_ref_branches").select("code, name").eq("org_id", member.orgId).order("code"),
    admin
      .from("acc_entity_branches")
      .select("branch_code, entity_id, emirate")
      .eq("org_id", member.orgId),
    admin
      .from("acc_entities")
      .select("id, ledger_start_date, tally_company")
      .eq("org_id", member.orgId),
    loadCompanyEntities(admin, member.orgId),
  ]);
  const ledgerStart = new Map((starts ?? []).map((e) => [e.id, e.ledger_start_date]));
  const ownCompany = new Map((starts ?? []).map((e) => [e.id, e.tally_company]));
  // what each entity is bridged to: its own Tally company, else (default entity) the Tally bridge setting
  const company = resolveCompanies(companyView.entities, companyView.fallback);
  const mapping = new Map((mapped ?? []).map((m) => [m.branch_code, m]));
  const withYears = new Set((years ?? []).map((y) => y.entity_id));
  const name = new Map(entities.map((e) => [e.id, e.name]));
  const defaultId = entities.find((e) => e.is_default)?.id ?? "";

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Entities and fiscal years"
        description="The legal entity whose books Pulse keeps, the branches that book into it and its fiscal years."
      >
        {manage && <EntityButton />}
      </PageHeader>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Entities</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>TRN</TableHead>
                <TableHead>Currency</TableHead>
                <TableHead>Fiscal year starts</TableHead>
                <TableHead>Ledger start</TableHead>
                <TableHead>Tally company</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entities.map((e) => (
                <TableRow key={e.id} className={e.active ? "" : "opacity-60"}>
                  <TableCell>
                    {e.name}
                    {e.is_default && (
                      <Badge variant="outline" className="ml-2">
                        default
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{e.trn ?? "-"}</TableCell>
                  <TableCell>{e.base_currency}</TableCell>
                  <TableCell>{MONTH_NAMES[e.fiscal_year_start_month - 1]}</TableCell>
                  <TableCell>
                    {ledgerStart.get(e.id) ?? (
                      <span className="text-muted-foreground">
                        not set (Tally is the book of record)
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {company.get(e.id) ? (
                      <>
                        {company.get(e.id)}
                        {!ownCompany.get(e.id) && (
                          <span className="text-muted-foreground ml-1 text-xs">
                            (the Tally bridge setting)
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">
                        {ownCompany.get(e.id)
                          ? "shared with another entity: not bridged"
                          : "none: not bridged"}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {manage && (
                      <LedgerStartButton entityId={e.id} current={ledgerStart.get(e.id) ?? null} />
                    )}
                    {manage && (
                      <EntityButton
                        entity={{
                          ...e,
                          hasYears: withYears.has(e.id),
                          tally_company: ownCompany.get(e.id) ?? null,
                        }}
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Branches</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <p className="text-muted-foreground mb-2 text-sm">
            The emirate splits standard-rated supplies on the VAT return.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Branch</TableHead>
                {entities.length > 1 && <TableHead>Entity</TableHead>}
                <TableHead>Emirate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(branches ?? []).map((b) => {
                const m = mapping.get(b.code);
                return (
                  <TableRow key={b.code}>
                    <TableCell>
                      {b.name}{" "}
                      <span className="text-muted-foreground font-mono text-xs">{b.code}</span>
                    </TableCell>
                    {manage ? (
                      <TableCell colSpan={entities.length > 1 ? 2 : 1}>
                        <BranchForm
                          branch={{
                            code: b.code,
                            entity_id: m?.entity_id ?? defaultId,
                            emirate: m?.emirate ?? "Dubai",
                          }}
                          entities={entities.map((e) => ({ id: e.id, name: e.name }))}
                          emirates={EMIRATES}
                        />
                      </TableCell>
                    ) : (
                      <>
                        {entities.length > 1 && (
                          <TableCell>{m ? name.get(m.entity_id) : "-"}</TableCell>
                        )}
                        <TableCell>{m?.emirate ?? "-"}</TableCell>
                      </>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Fiscal years</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <p className="text-muted-foreground mb-2 text-sm">
            A fiscal year is created by the first posting dated in it (or a period added under
            Periods).
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Year</TableHead>
                {entities.length > 1 && <TableHead>Entity</TableHead>}
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(years ?? []).map((y) => (
                <TableRow key={y.id}>
                  <TableCell>{y.label}</TableCell>
                  {entities.length > 1 && <TableCell>{name.get(y.entity_id)}</TableCell>}
                  <TableCell>{y.start_date}</TableCell>
                  <TableCell>{y.end_date}</TableCell>
                  <TableCell>{y.status}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
