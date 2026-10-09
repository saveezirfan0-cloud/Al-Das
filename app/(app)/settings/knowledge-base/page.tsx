import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { aiEnv } from "@/lib/env";
import { readAiSettings } from "@/lib/ai/settings";
import { can, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { AiSettingsCard } from "./ai-settings-card";
import { KnowledgeManager } from "./knowledge-manager";

export const metadata = { title: "AI & knowledge base" };

export default async function KnowledgeBasePage() {
  const member = await requireMember();
  const canSettings = can(member, "settings.manage");
  const canKb = can(member, "kb.manage");
  if (!canSettings && !canKb) throw new ForbiddenError("kb.manage");

  const admin = createAdminClient();
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
  const since30 = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const [{ data: org }, { data: groups }, { data: sources }, { data: usage }, { data: feedback }] = await Promise.all([
    admin.from("orgs").select("settings").eq("id", member.orgId).single(),
    admin.from("kb_groups").select("id, name, description").eq("org_id", member.orgId).order("name"),
    admin
      .from("kb_sources")
      .select("id, group_id, kind, name, url, status, error, chunk_count, last_ingested_at, created_at")
      .eq("org_id", member.orgId)
      .order("created_at", { ascending: false }),
    admin
      .from("ai_usage")
      .select("feature, status, input_tokens, output_tokens")
      .eq("org_id", member.orgId)
      .gte("created_at", monthStart)
      .limit(20_000),
    admin.from("kb_feedback").select("feature, positive").eq("org_id", member.orgId).gte("created_at", since30).limit(20_000),
  ]);

  const settings = readAiSettings(org?.settings);
  const env = aiEnv();
  const totals = (usage ?? []).reduce(
    (acc, u) => {
      acc.calls += 1;
      acc.input += u.input_tokens;
      acc.output += u.output_tokens;
      if (u.status === "needs_review") acc.review += 1;
      if (u.status === "error" || u.status === "refused") acc.failed += 1;
      return acc;
    },
    { calls: 0, input: 0, output: 0, review: 0, failed: 0 },
  );
  const up = (feedback ?? []).filter((f) => f.positive).length;
  const down = (feedback ?? []).length - up;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="AI & knowledge base"
        description="Draft help for staff in the inbox, grounded in your own clinic information. Drafts only: a person always reviews and sends."
      />

      <AiSettingsCard
        canEdit={canSettings}
        settings={settings}
        groups={(groups ?? []).map((g) => ({ id: g.id, name: g.name }))}
        providerReady={Boolean(env.ANTHROPIC_API_KEY)}
        embeddingsReady={env.EMBEDDINGS_PROVIDER === "fake" || Boolean(env.EMBEDDINGS_API_KEY)}
        embeddingsFake={env.EMBEDDINGS_PROVIDER === "fake"}
        model={env.ANTHROPIC_MODEL}
      />

      <Card>
        <CardHeader>
          <CardTitle>This month</CardTitle>
          <CardDescription>Counts only. Message content is never stored with usage.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4 text-sm md:grid-cols-5">
          <Stat label="AI requests" value={totals.calls} />
          <Stat label="Input tokens" value={totals.input} />
          <Stat label="Output tokens" value={totals.output} />
          <Stat label="Flagged for review" value={totals.review} />
          <Stat label="Failed or declined" value={totals.failed} />
          <Stat label="Helpful (30 days)" value={up} />
          <Stat label="Not helpful (30 days)" value={down} />
        </CardContent>
      </Card>

      {canKb ? (
        <KnowledgeManager groups={groups ?? []} sources={sources ?? []} />
      ) : (
        <p className="text-muted-foreground text-sm">You can view AI settings; managing the knowledge base needs the “Manage the knowledge base” permission.</p>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-2xl font-semibold tabular-nums">{value.toLocaleString()}</div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </div>
  );
}
