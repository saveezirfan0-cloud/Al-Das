import Link from "next/link";

import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
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
import { money } from "@/lib/finance/format";
import {
  fieldsFor,
  IMPORT_KINDS,
  isLabImportKind,
  LAB_IMPORT_KINDS,
} from "@/lib/finance/import-kinds";
import { isProviderKind, PROVIDER_KINDS } from "@/lib/finance/labs";
import { loadLabSettings } from "@/lib/finance/labs-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll } from "@/lib/supabase/fetch-all";

import { FormatButton, type FormatView } from "../../bank/settings/forms";
import { saveLabFormat } from "./actions";
import { DeleteTestButton, LabSettingsForm, ProviderButton, TestsButton } from "./forms";

export const metadata = { title: "Lab providers and tests" };
export const dynamic = "force-dynamic";

export default async function LabSettingsPage() {
  const member = await requirePerm("finance.labs.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const [{ data: providers }, { data: tests }, { data: formatRows }, settings] = await Promise.all([
    admin
      .from("fin_providers")
      .select("id, name, kind, fixed_monthly_fee, allocation_basis, active")
      .eq("org_id", member.orgId)
      .order("name"),
    // Up to 5,000 tests, read in pages (PostgREST returns at most 1,000 per request).
    fetchAll(
      (from, to) =>
        admin
          .from("fin_ref_provider_tests")
          .select("id, provider_id, code, expected_days, agreed_price")
          .eq("org_id", member.orgId)
          .order("code")
          .order("id")
          .range(from, to),
      { max: 5000 },
    ),
    admin
      .from("fin_import_formats")
      .select("id, kind, name, mapping, date_format, amount_style, active")
      .eq("org_id", member.orgId)
      .in("kind", [...LAB_IMPORT_KINDS])
      .order("name"),
    loadLabSettings(admin, member.orgId),
  ]);
  const formats: FormatView[] = (formatRows ?? []).map((f) => ({
    ...f,
    mapping: (f.mapping ?? {}) as Record<string, string>,
  }));
  const layoutHint =
    "Map each field to the header of its column, once per provider's file. There is no field for a patient's name or ID number: those columns are never read.";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Lab providers and tests"
        description="Providers, the expected turnaround and agreed price of each test, the layout of each provider's file, and the matching settings. Every change is audited."
      >
        <Button asChild variant="outline">
          <Link href="/finance/labs">Back to labs and referrals</Link>
        </Button>
      </PageHeader>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Providers</CardTitle>
          <ProviderButton />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Monthly fee</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(providers ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4}>
                    <EmptyState
                      title="No providers yet"
                      description="Add the in-house lab, each send-out lab, and the hospitals and radiology providers you refer to."
                      className="border-0 p-6"
                    />
                  </TableCell>
                </TableRow>
              ) : (
                (providers ?? []).map((p) => (
                  <TableRow key={p.id} className={p.active ? "" : "opacity-60"}>
                    <TableCell>{p.name}</TableCell>
                    <TableCell>
                      {isProviderKind(p.kind) ? PROVIDER_KINDS[p.kind] : p.kind}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {p.kind === "in_house_lab" ? money(p.fixed_monthly_fee) : "-"}
                    </TableCell>
                    <TableCell className="text-right">
                      <ProviderButton
                        provider={{
                          ...p,
                          fixed_monthly_fee:
                            p.fixed_monthly_fee === null ? null : Number(p.fixed_monthly_fee),
                        }}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {(providers ?? []).map((p) => {
        const own = (tests ?? []).filter((t) => t.provider_id === p.id);
        return (
          <Card key={p.id}>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <div>
                <CardTitle className="text-base">Tests of {p.name}</CardTitle>
                <CardDescription>
                  Expected turnaround (days from sample to result) and the agreed price.
                  {p.kind === "send_out_lab"
                    ? " Unite lines with these codes and no record on the lab's file are listed as billed but not on the file."
                    : ""}
                </CardDescription>
              </div>
              <TestsButton providerId={p.id} providerName={p.name} />
            </CardHeader>
            <CardContent>
              {own.length === 0 ? (
                <p className="text-muted-foreground text-sm">No tests yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Code</TableHead>
                      <TableHead>Expected days</TableHead>
                      <TableHead className="text-right">Agreed price</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {own.map((t) => (
                      <TableRow key={t.id}>
                        <TableCell className="font-mono text-xs">{t.code}</TableCell>
                        <TableCell className="tabular-nums">{t.expected_days ?? "-"}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {t.agreed_price === null ? "-" : money(t.agreed_price)}
                        </TableCell>
                        <TableCell className="text-right">
                          <DeleteTestButton id={t.id} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        );
      })}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base">File layouts</CardTitle>
            <CardDescription>
              The in-house lab sends an activity report; send-out labs, hospitals and radiology send
              an invoice. Only the mapped columns are read.
            </CardDescription>
          </div>
          <FormatButton kinds={LAB_IMPORT_KINDS} action={saveLabFormat} description={layoutHint} />
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Layout</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Columns read</TableHead>
                <TableHead>Dates</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {formats.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5}>
                    <EmptyState
                      title="No layouts yet"
                      description="Add one when the first sample file arrives."
                      className="border-0 p-6"
                    />
                  </TableCell>
                </TableRow>
              ) : (
                formats.map((f) => (
                  <TableRow key={f.id} className={f.active ? "" : "opacity-60"}>
                    <TableCell>{f.name}</TableCell>
                    <TableCell>
                      {isLabImportKind(f.kind) ? IMPORT_KINDS[f.kind].label : f.kind}
                    </TableCell>
                    <TableCell className="text-xs">
                      {isLabImportKind(f.kind) &&
                        fieldsFor(f.kind, "signed")
                          .filter((x) => f.mapping[x.key])
                          .map((x) => `${x.spec.label}: "${f.mapping[x.key]}"`)
                          .join("; ")}
                    </TableCell>
                    <TableCell>{f.date_format}</TableCell>
                    <TableCell className="text-right">
                      <FormatButton
                        format={f}
                        kinds={LAB_IMPORT_KINDS}
                        action={saveLabFormat}
                        description={layoutHint}
                      />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Matching</CardTitle>
        </CardHeader>
        <CardContent>
          <LabSettingsForm
            windowDays={settings.windowDays}
            priceTolerance={settings.priceTolerance}
          />
        </CardContent>
      </Card>
    </div>
  );
}
