import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { requirePerm } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { VariablesManager } from "./variables-manager";

export const metadata = { title: "Flow variables" };

export default async function VariablesPage() {
  const member = await requirePerm("flows.manage");
  const { data } = await createAdminClient().from("flow_variables").select("id, key, value, enabled").eq("org_id", member.orgId).order("key");
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Flow variables" description="Workspace-wide values you can use in any flow as {vars.NAME}: clinic phone, booking link, opening hours text.">
        <Button variant="outline" asChild>
          <Link href="/flows">Back to flows</Link>
        </Button>
      </PageHeader>
      <VariablesManager rows={data ?? []} />
    </div>
  );
}
