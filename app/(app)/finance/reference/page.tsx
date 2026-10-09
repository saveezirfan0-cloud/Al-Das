import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requirePerm } from "@/lib/auth/session";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/server";

import {
  addBranch,
  rederiveBranchesAction,
  saveBranch,
  saveDoctor,
  saveRule,
  saveService,
} from "./actions";
import { ActionButton, RowForm } from "./row-form";

export const metadata = { title: "Reference data" };
export const dynamic = "force-dynamic";

const TABS = [
  ["branches", "Branches"],
  ["services", "Service categories"],
  ["doctors", "Doctors"],
  ["rules", "Exception rules"],
] as const;
const PAGE_SIZE = 50;

const field = "h-8 text-sm";

export default async function ReferencePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; unmapped?: string; page?: string }>;
}) {
  await requirePerm("finance.reference.manage");
  const sp = await searchParams;
  const tab = TABS.some(([k]) => k === sp.tab) ? (sp.tab as (typeof TABS)[number][0]) : "branches";
  const page = Math.max(1, Number(sp.page) || 1);
  const supabase = await createClient(); // RLS applies

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Reference data"
        description="Mappings that turn Unite and Diligence data into branches, departments and service categories."
      >
        <ActionButton action={rederiveBranchesAction}>Re-derive branches</ActionButton>
      </PageHeader>

      <div className="flex gap-1 border-b">
        {TABS.map(([key, label]) => (
          <Link
            key={key}
            href={`/finance/reference?tab=${key}`}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm",
              tab === key
                ? "border-primary font-medium"
                : "text-muted-foreground border-transparent",
            )}
          >
            {label}
          </Link>
        ))}
      </div>

      {tab === "branches" && <Branches supabase={supabase} />}
      {tab === "services" && (
        <Services supabase={supabase} unmapped={sp.unmapped === "1"} page={page} />
      )}
      {tab === "doctors" && <Doctors supabase={supabase} page={page} />}
      {tab === "rules" && <Rules supabase={supabase} />}
    </div>
  );
}

type Sb = Awaited<ReturnType<typeof createClient>>;

async function Branches({ supabase }: { supabase: Sb }) {
  const { data } = await supabase.from("fin_ref_branches").select("*").order("code");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Branches</CardTitle>
        <CardDescription>
          Enter the clinic name exactly as Unite sends it (shown in invoices as “unknown clinic”
          until mapped). After saving, press “Re-derive branches”.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {(data ?? []).map((b) => (
          <RowForm key={b.id} action={saveBranch}>
            <input type="hidden" name="id" value={b.id} />
            <Badge variant="outline">{b.code}</Badge>
            <Input
              name="name"
              defaultValue={b.name}
              className={cn(field, "w-40")}
              aria-label="Name"
            />
            <Input
              name="unite_clinic_long_name"
              defaultValue={b.unite_clinic_long_name ?? ""}
              placeholder="Unite clinic long name"
              className={cn(field, "w-64")}
            />
            <Input
              name="unite_clinic_short_name"
              defaultValue={b.unite_clinic_short_name ?? ""}
              placeholder="short name"
              className={cn(field, "w-32")}
            />
            <Label className="flex items-center gap-1 text-xs">
              <input type="checkbox" name="active" defaultChecked={b.active} /> active
            </Label>
          </RowForm>
        ))}
        <RowForm
          action={addBranch}
          label="Add branch"
          className="flex flex-wrap items-center gap-2 border-t pt-3"
        >
          <Input name="code" placeholder="Code" className={cn(field, "w-20")} />
          <Input name="name" placeholder="Branch name" className={cn(field, "w-48")} />
        </RowForm>
      </CardContent>
    </Card>
  );
}

async function Services({
  supabase,
  unmapped,
  page,
}: {
  supabase: Sb;
  unmapped: boolean;
  page: number;
}) {
  let q = supabase
    .from("fin_ref_services")
    .select("*", { count: "exact" })
    .order("item_code")
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (unmapped) q = q.eq("service_category", "Unmapped");
  const [{ data, count }, { data: cats }] = await Promise.all([
    q,
    supabase
      .from("fin_ref_services")
      .select("service_category")
      .neq("service_category", "Unmapped")
      .limit(1000),
  ]);
  const categories = [...new Set((cats ?? []).map((c) => c.service_category))].sort();
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const href = (p: number, u = unmapped) =>
    `/finance/reference?tab=services&page=${p}${u ? "&unmapped=1" : ""}`;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Service categories</CardTitle>
        <CardDescription>
          New Unite item codes arrive as “Unmapped”. Give each one a category so revenue reports
          group it correctly. {count ?? 0} shown.
        </CardDescription>
        <div className="flex gap-2">
          <Button asChild size="sm" variant={unmapped ? "secondary" : "outline"}>
            <Link href={href(1, !unmapped)}>{unmapped ? "Show all" : "Only unmapped"}</Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <datalist id="categories">
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        {(data ?? []).map((s) => (
          <RowForm key={s.item_code} action={saveService}>
            <input type="hidden" name="item_code" value={s.item_code} />
            <span className="w-28 font-mono text-xs">{s.item_code}</span>
            <span className="text-muted-foreground w-64 truncate text-xs">
              {s.description ?? ""}
            </span>
            <Input
              name="cpt_code"
              defaultValue={s.cpt_code ?? ""}
              placeholder="CPT"
              className={cn(field, "w-24")}
            />
            <Input
              name="service_category"
              list="categories"
              defaultValue={s.service_category}
              className={cn(field, "w-48", s.service_category === "Unmapped" && "border-amber-500")}
            />
          </RowForm>
        ))}
        {(data ?? []).length === 0 && (
          <p className="text-muted-foreground text-sm">Nothing to show.</p>
        )}
        <div className="flex justify-between pt-2 text-sm">
          <span className="text-muted-foreground">
            Page {page} of {pages}
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Button asChild size="sm" variant="outline">
                <Link href={href(page - 1)}>Previous</Link>
              </Button>
            )}
            {page < pages && (
              <Button asChild size="sm" variant="outline">
                <Link href={href(page + 1)}>Next</Link>
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

async function Doctors({ supabase, page }: { supabase: Sb; page: number }) {
  const { data, count } = await supabase
    .from("fin_ref_doctors")
    .select("*", { count: "exact" })
    .order("dha_id")
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  const pages = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Doctors</CardTitle>
        <CardDescription>
          Department and specialty drive the revenue-by-department report. Doctors appear here when
          they first show up on an invoice.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {(data ?? []).map((d) => (
          <RowForm key={d.dha_id} action={saveDoctor}>
            <input type="hidden" name="dha_id" value={d.dha_id} />
            <span className="w-28 font-mono text-xs">{d.dha_id}</span>
            <Input
              name="name"
              defaultValue={d.name ?? ""}
              placeholder="Name"
              className={cn(field, "w-48")}
            />
            <Input
              name="department"
              defaultValue={d.department ?? ""}
              placeholder="Department"
              className={cn(field, "w-40")}
            />
            <Input
              name="specialty"
              defaultValue={d.specialty ?? ""}
              placeholder="Specialty"
              className={cn(field, "w-40")}
            />
            <Label className="flex items-center gap-1 text-xs">
              <input type="checkbox" name="active" defaultChecked={d.active} /> active
            </Label>
          </RowForm>
        ))}
        {(data ?? []).length === 0 && (
          <p className="text-muted-foreground text-sm">
            No doctors yet. They are added automatically from invoices.
          </p>
        )}
        <div className="flex justify-between pt-2 text-sm">
          <span className="text-muted-foreground">
            Page {page} of {pages}
          </span>
          <div className="flex gap-2">
            {page > 1 && (
              <Button asChild size="sm" variant="outline">
                <Link href={`/finance/reference?tab=doctors&page=${page - 1}`}>Previous</Link>
              </Button>
            )}
            {page < pages && (
              <Button asChild size="sm" variant="outline">
                <Link href={`/finance/reference?tab=doctors&page=${page + 1}`}>Next</Link>
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

async function Rules({ supabase }: { supabase: Sb }) {
  const { data } = await supabase.from("fin_ref_exception_rules").select("*").order("rule_code");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Exception rules</CardTitle>
        <CardDescription>
          Thresholds are in days. Defaults are placeholders to agree with Sharaf and Finance. A
          switched-off rule opens no exceptions.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {(data ?? []).map((r) => (
          <RowForm key={r.rule_code} action={saveRule}>
            <input type="hidden" name="rule_code" value={r.rule_code} />
            <Badge variant="outline">{r.rule_code}</Badge>
            <span className="w-96 text-sm">{r.description}</span>
            <Badge variant="secondary">{r.owner_role}</Badge>
            <Input
              name="threshold_days"
              type="number"
              min={0}
              defaultValue={r.threshold_days ?? ""}
              placeholder="days"
              className={cn(field, "w-20")}
            />
            <Label className="flex items-center gap-1 text-xs">
              <input type="checkbox" name="active" defaultChecked={r.active} /> active
            </Label>
          </RowForm>
        ))}
      </CardContent>
    </Card>
  );
}
