import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { loadArSettings } from "@/lib/accounting/receivables-server";
import { can, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { ArSettingsForm } from "./form";

export const metadata = { title: "Sales settings" };
export const dynamic = "force-dynamic";

export default async function ReceivablesSettingsPage() {
  const member = await requireMember();
  if (!can(member, "accounting.settings.manage"))
    throw new ForbiddenError("accounting.settings.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const settings = await loadArSettings(admin, member.orgId);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Sales settings"
        description="The approval limit for sales invoices and credit notes, the document prefixes, and what the tax invoice prints about the clinic. The entity's name and TRN come from Entities and fiscal years."
      />
      <Card>
        <CardContent className="pt-6">
          <ArSettingsForm value={settings} canEdit />
        </CardContent>
      </Card>
    </div>
  );
}
