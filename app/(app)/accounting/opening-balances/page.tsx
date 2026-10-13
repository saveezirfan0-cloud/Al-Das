import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { loadAccounts } from "@/lib/accounting/accounting-server";
import { can, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { OpeningGrid } from "./grid";

export const metadata = { title: "Opening balances" };
export const dynamic = "force-dynamic";

export default async function OpeningBalancesPage() {
  const member = await requireMember();
  if (!can(member, "accounting.import")) throw new ForbiddenError("accounting.import");
  const admin = createAdminClient(); // service role AFTER the permission check
  const [accounts, { data: existing }] = await Promise.all([
    loadAccounts(admin, member.orgId),
    admin
      .from("acc_journals")
      .select("id, number, journal_date, status, source_kind")
      .eq("org_id", member.orgId)
      .eq("voucher_type", "opening")
      .in("status", ["draft", "posted"])
      .order("journal_date", { ascending: false })
      .limit(10),
  ]);
  const ledgers = accounts
    .filter((a) => !a.is_group && a.is_active)
    .map((a) => ({ id: a.id, code: a.code, name: a.name, nature: a.nature }));
  const year = new Date().getUTCFullYear();

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Opening balances"
        description="Type the balance of each account at the opening date when you do not import them from Tally. They are saved as one opening journal that someone else with the post permission checks and posts. Control accounts (bank, cash, receivables, payables, VAT) take opening balances too."
      />
      {(existing ?? []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Opening journals already in the books</CardTitle>
            <CardDescription>
              A second opening journal adds to the first. To change one, reverse it and enter the
              balances again.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm">
            {(existing ?? []).map((j) => (
              <Link key={j.id} href={`/accounting/journals/${j.id}`} className="underline">
                {j.number ?? "Draft"} · {j.journal_date} · {j.status}
                {j.source_kind === "opening" ? " · from the Tally import" : ""}
              </Link>
            ))}
          </CardContent>
        </Card>
      )}
      <Card>
        <CardContent className="pt-6">
          <OpeningGrid accounts={ledgers} defaultDate={`${year}-06-30`} />
        </CardContent>
      </Card>
    </div>
  );
}
