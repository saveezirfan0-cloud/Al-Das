import { PageHeader } from "@/components/shell/page-header";
import { readCopilotSettings } from "@/lib/ai/copilot/settings";
import { readAiSettings } from "@/lib/ai/settings";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { redirect } from "next/navigation";

import { AiCopilotsSettings } from "./ai-copilots-settings";

export const metadata = { title: "AI copilots" };
export const dynamic = "force-dynamic";

export default async function AiCopilotsSettingsPage() {
  const member = await requireMember();
  const canAdmin = can(member, "settings.manage");
  const canSign = can(member, "clinical.settings.manage");
  if (!canAdmin && !canSign) redirect("/settings");
  const ai = readAiSettings(member.org.settings);
  const copilot = readCopilotSettings(member.org.settings);

  // Calls this calendar month by feature: counts only.
  const since = new Date(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
  ).toISOString();
  const { data: usage } = await createAdminClient()
    .from("ai_usage")
    .select("feature, status")
    .eq("org_id", member.orgId)
    .gte("created_at", since)
    .in("feature", ["flow_copilot", "campaign_audience", "campaign_copy", "intent"])
    .limit(5000);
  const counts: Record<string, { calls: number; problems: number }> = {};
  for (const u of usage ?? []) {
    const c = (counts[u.feature] ??= { calls: 0, problems: 0 });
    c.calls += 1;
    if (u.status !== "ok") c.problems += 1;
  }

  let signedBy: string | null = null;
  if (copilot.tag_flows.signed_by) {
    const { data: p } = await createAdminClient()
      .from("profiles")
      .select("first_name, last_name, email")
      .eq("id", copilot.tag_flows.signed_by)
      .maybeSingle();
    signedBy = p ? `${p.first_name} ${p.last_name}`.trim() || p.email : null;
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="AI copilots"
        description="Flow Copilot, Campaign Copilot, message labelling, emergency wording and the weekly reply-quality report. Everything the AI writes here is a draft for a person to check."
      />
      <AiCopilotsSettings
        aiEnabled={ai.enabled}
        intentDetection={copilot.intent_detection}
        tagFlows={{ ...copilot.tag_flows, signedByName: signedBy }}
        canAdmin={canAdmin}
        canSign={canSign}
        usage={counts}
      />
    </div>
  );
}
