import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { loadSalesDetail } from "@/lib/accounting/receivables-server";
import { ForbiddenError, can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { formLines, salesFormOptions } from "../../form-options";
import { SalesForm } from "../../sales-form";

export const metadata = { title: "Edit draft" };
export const dynamic = "force-dynamic";

export default async function EditSalesDocPage({ params }: { params: Promise<{ id: string }> }) {
  const member = await requireMember();
  if (!can(member, "accounting.sales.manage")) throw new ForbiddenError("accounting.sales.manage");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const admin = createAdminClient(); // service role AFTER the permission check
  const [d, options] = await Promise.all([
    loadSalesDetail(admin, member.orgId, id),
    salesFormOptions(admin, member.orgId),
  ]);
  if (!d || d.status !== "draft") notFound();
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={d.kind === "credit_note" ? "Edit credit note draft" : "Edit invoice draft"}
        description="Saving makes you the preparer of the draft."
      />
      <Card>
        <CardContent className="pt-6">
          <SalesForm
            options={options}
            initial={{
              id: d.id,
              kind: d.kind,
              customer_id: d.customer.id,
              original_invoice_id: d.original?.id,
              original_number: d.original?.number,
              invoice_date: d.invoice_date,
              supply_date: d.supply_date ?? "",
              due_date: d.due_date ?? "",
              event_date: d.event_date ?? "",
              credit_reason: d.credit_reason ?? "",
              reference: d.reference ?? "",
              notes: d.notes ?? "",
              lines: formLines(d),
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
