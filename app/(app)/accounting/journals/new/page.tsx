import { PageHeader } from "@/components/shell/page-header";
import { loadJournalOptions } from "@/lib/accounting/accounting-server";
import { requirePerm } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { createAdminClient } from "@/lib/supabase/admin";

import { toFormOptions } from "../form-options";
import { JournalForm } from "../journal-form";

export const metadata = { title: "New journal" };
export const dynamic = "force-dynamic";

export default async function NewJournalPage() {
  const member = await requirePerm("accounting.journals.prepare");
  const admin = createAdminClient(); // service role AFTER the permission check
  const options = await loadJournalOptions(admin, member.orgId);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="New journal"
        description="Save it as a draft, then submit it; someone else posts it. Control accounts (receivables, payables, bank, cash, VAT) take automatic postings only."
      />
      <JournalForm options={toFormOptions(options, member, todayIn(member.org.timezone))} />
    </div>
  );
}
