import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { requirePerm } from "@/lib/auth/session";
import { readFrontDeskSettings } from "@/lib/front-desk/settings";
import { createAdminClient } from "@/lib/supabase/admin";

import { FrontDeskSettingsForm } from "./settings-form";

export const metadata = { title: "Front desk settings" };

export default async function FrontDeskSettingsPage() {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const [{ data: org }, { data: templates }, { data: channels }] = await Promise.all([
    admin.from("orgs").select("settings").eq("id", member.orgId).single(),
    admin
      .from("wa_templates")
      .select("id, name, language, status, category")
      .eq("org_id", member.orgId)
      .is("archived_at", null)
      .order("name"),
    admin
      .from("channels")
      .select("id, name, display_phone")
      .eq("org_id", member.orgId)
      .order("name"),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Front desk"
        description="Waiting-list offers, the one-tap messages, the board and the desk QR code."
      >
        <Button size="sm" variant="outline" asChild>
          <Link href="/front-desk/qr">Open the QR poster</Link>
        </Button>
      </PageHeader>
      <FrontDeskSettingsForm
        initial={readFrontDeskSettings(org?.settings)}
        templates={templates ?? []}
        channels={channels ?? []}
      />
    </div>
  );
}
