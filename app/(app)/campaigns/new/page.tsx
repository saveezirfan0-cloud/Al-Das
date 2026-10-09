import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { requirePerm } from "@/lib/auth/session";
import { sentThisMonth } from "@/lib/campaigns/queries";
import { loadCustomFields } from "@/lib/contacts/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

import {
  NewCampaignForm,
  type FormChannel,
  type FormSegment,
  type FormTemplate,
} from "./new-campaign-form";

export const metadata = { title: "New campaign" };
export const dynamic = "force-dynamic";

export default async function NewCampaignPage() {
  const member = await requirePerm("campaigns.create");
  const supabase = await createClient();
  const admin = createAdminClient();

  const [{ data: channels }, { data: templates }, { data: segments }, customFields, sent] =
    await Promise.all([
      supabase
        .from("channels")
        .select("id, name, waba_id, status, quality_rating, messaging_limit_tier, display_phone")
        .eq("org_id", member.orgId)
        .eq("status", "active")
        .order("name"),
      supabase
        .from("wa_templates")
        .select("id, name, language, category, status, waba_id, components, variable_map")
        .eq("org_id", member.orgId)
        .eq("status", "APPROVED")
        .is("archived_at", null)
        .order("name"),
      supabase
        .from("segments")
        .select("id, name, kind, member_count")
        .eq("org_id", member.orgId)
        .order("name"),
      loadCustomFields(admin, member.orgId),
      sentThisMonth(supabase, member.orgId),
    ]);

  const formChannels: FormChannel[] = (channels ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    wabaId: c.waba_id,
    phone: c.display_phone,
    quality: c.quality_rating,
    tier: c.messaging_limit_tier,
  }));
  const formTemplates: FormTemplate[] = (templates ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    language: t.language,
    category: t.category,
    wabaId: t.waba_id,
    components: t.components as unknown as MetaTemplateComponent[],
    variableMap:
      t.variable_map && typeof t.variable_map === "object" && !Array.isArray(t.variable_map)
        ? Object.fromEntries(
            Object.entries(t.variable_map).filter(
              (e): e is [string, string] => typeof e[1] === "string",
            ),
          )
        : {},
  }));
  const formSegments: FormSegment[] = (segments ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    count: s.member_count,
  }));

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="New campaign"
        description={`Sent through the outbound queue with the number's rate limit. ${sent.toLocaleString()} campaign messages sent this month.`}
      >
        <Button asChild variant="outline" size="sm">
          <Link href="/campaigns">Back to campaigns</Link>
        </Button>
      </PageHeader>
      <NewCampaignForm
        channels={formChannels}
        templates={formTemplates}
        segments={formSegments}
        customFields={customFields.map((f) => ({ key: f.key, label: f.label }))}
        timezone={member.org.timezone}
      />
    </div>
  );
}
