import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/shell/page-header";
import { loadJournalDetail, loadJournalOptions } from "@/lib/accounting/accounting-server";
import { isManualVoucherType } from "@/lib/accounting/journal";
import { requirePerm } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";

import { toFormOptions } from "../../form-options";
import { JournalForm } from "../../journal-form";

export const metadata = { title: "Edit journal" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EditJournalPage({ params }: { params: Promise<{ id: string }> }) {
  const member = await requirePerm("accounting.journals.prepare");
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const admin = createAdminClient(); // service role AFTER the permission check
  const [j, options] = await Promise.all([
    loadJournalDetail(admin, member.orgId, id),
    loadJournalOptions(admin, member.orgId),
  ]);
  if (!j) notFound();
  if (j.status !== "draft" || j.source_kind || !isManualVoucherType(j.voucher_type))
    redirect(`/accounting/journals/${id}`);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Edit journal"
        description="Saving makes you its preparer and takes it out of the approval queue; submit it again afterwards."
      />
      <JournalForm
        options={toFormOptions(options, member, todayIn(member.org.timezone))}
        initial={{
          id: j.id,
          entity_id: j.entity_id,
          voucher_type: j.voucher_type,
          journal_date: j.journal_date,
          narration: j.narration,
          is_adjustment: j.is_adjustment,
          auto_reverse_on: j.auto_reverse_on ?? "",
          lines: j.lines.map((l) => ({
            account_id: l.account_id,
            debit: l.debit ? l.debit.toFixed(2) : "",
            credit: l.credit ? l.credit.toFixed(2) : "",
            description: l.description ?? "",
            tax_code_id: l.tax_code_id ?? "",
            branch_code: l.branch_code ?? "",
            department: l.department ?? "",
            doctor_id: l.doctor_id ?? "",
            payer_id: l.payer_id ?? "",
            supplier_id: l.supplier_id ?? "",
            cost_centre_id: l.cost_centre_id ?? "",
          })),
        }}
      />
    </div>
  );
}
