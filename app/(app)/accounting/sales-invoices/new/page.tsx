import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { loadSalesDetail } from "@/lib/accounting/receivables-server";
import { ForbiddenError, can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { formLines, salesFormOptions } from "../form-options";
import { SalesForm, type SalesFormInitial } from "../sales-form";

export const metadata = { title: "New sales document" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NewSalesDocPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; credit_for?: string }>;
}) {
  const member = await requireMember();
  if (!can(member, "accounting.sales.manage")) throw new ForbiddenError("accounting.sales.manage");
  const sp = await searchParams;
  const admin = createAdminClient(); // service role AFTER the permission check
  const options = await salesFormOptions(admin, member.orgId);

  let initial: SalesFormInitial = {
    kind: "invoice",
    customer_id: UUID.test(sp.customer ?? "") ? sp.customer! : "",
    lines: [],
  };
  if (UUID.test(sp.credit_for ?? "")) {
    const inv = await loadSalesDetail(admin, member.orgId, sp.credit_for!);
    if (!inv || inv.kind !== "invoice" || !["issued", "part_paid", "paid"].includes(inv.status))
      return (
        <p className="text-sm">
          A credit note is raised against an issued invoice that is not void.{" "}
          <Link className="underline" href="/accounting/sales-invoices">
            Back to sales invoices
          </Link>
        </p>
      );
    initial = {
      kind: "credit_note",
      customer_id: inv.customer.id,
      original_invoice_id: inv.id,
      original_number: inv.number,
      reference: inv.reference ?? "",
      lines: formLines(inv),
    };
  }

  const credit = initial.kind === "credit_note";
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={credit ? `Credit note against ${initial.original_number}` : "New sales invoice"}
        description={
          credit
            ? "The lines of the invoice are copied: change the quantities or prices to what is credited. It cannot be more than what is left to credit."
            : "Saved as a draft. Issue it from its page: it then gets its number and is posted."
        }
      />
      <Card>
        <CardContent className="pt-6">
          <SalesForm options={options} initial={initial} />
        </CardContent>
      </Card>
    </div>
  );
}
