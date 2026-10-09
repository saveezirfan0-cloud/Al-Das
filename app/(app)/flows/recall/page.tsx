import Link from "next/link";
import { ArrowLeft, PhoneCall } from "lucide-react";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { loadClinicalSettings } from "@/lib/clinical/engine";
import { resolveSendMode } from "@/lib/clinical/recall";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { RecallWorkspace } from "./recall-workspace";
import type { ProgrammeView, RecallBootstrap } from "./types";

export const metadata = { title: "Recall programmes" };
export const dynamic = "force-dynamic";

export default async function RecallPage() {
  const member = await requirePerm("flows.manage");
  const supabase = await createClient();
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const [programmes, templateRows, waTemplates, channels, runs, sends, settings] =
    await Promise.all([
      supabase
        .from("recall_programmes")
        .select("*")
        .eq("org_id", member.orgId)
        .order("created_at")
        .order("name"),
      supabase
        .from("recall_programme_templates")
        .select(
          "id, programme_id, segment_key, wa_template_id, legacy_sanoflow_template_id, variables_map, active",
        )
        .eq("org_id", member.orgId)
        .order("segment_key"),
      supabase
        .from("wa_templates")
        .select("id, name, language, status, category, clinical_approval")
        .eq("org_id", member.orgId)
        .is("archived_at", null)
        .order("name"),
      supabase.from("channels").select("id, name").eq("org_id", member.orgId).order("name"),
      supabase
        .from("recall_runs")
        .select(
          "programme_id, started_at, dry_run, queued, scanned, skipped, by_segment, trigger, send_mode, gate_open",
        )
        .eq("org_id", member.orgId)
        .order("started_at", { ascending: false })
        .limit(300),
      supabase
        .from("recall_sends")
        .select("programme_id, status, replied_at, booked_at")
        .eq("org_id", member.orgId)
        .gte("queued_at", since)
        .limit(5000),
      loadClinicalSettings(createAdminClient(), member.orgId),
    ]);

  const lastRun = new Map<string, NonNullable<typeof runs.data>[number]>();
  for (const r of runs.data ?? []) if (!lastRun.has(r.programme_id)) lastRun.set(r.programme_id, r);
  const funnel = new Map<
    string,
    { sent: number; replied: number; booked: number; failed: number }
  >();
  for (const s of sends.data ?? []) {
    const f = funnel.get(s.programme_id) ?? { sent: 0, replied: 0, booked: 0, failed: 0 };
    if (["sent", "delivered", "read"].includes(s.status)) f.sent++;
    if (s.status === "failed") f.failed++;
    if (s.replied_at) f.replied++;
    if (s.booked_at) f.booked++;
    funnel.set(s.programme_id, f);
  }

  const views: ProgrammeView[] = (programmes.data ?? []).map((p) => {
    const lr = lastRun.get(p.id);
    return {
      id: p.id,
      key: p.key,
      name: p.name,
      kind: p.kind,
      eligibility: p.eligibility as ProgrammeView["eligibility"],
      status: p.status as ProgrammeView["status"],
      cron: p.cron_expression,
      repeat: p.repeat_policy as "once" | "per_cycle",
      maxPerRun: p.max_per_run,
      modeOverride: p.send_mode_override as "test" | "live" | null,
      channelId: p.channel_id,
      managedBy: p.managed_by,
      config: (p.config ?? {}) as Record<string, unknown>,
      templates: (templateRows.data ?? [])
        .filter((t) => t.programme_id === p.id)
        .map((t) => ({
          id: t.id,
          segment: t.segment_key,
          waTemplateId: t.wa_template_id,
          legacyId: t.legacy_sanoflow_template_id,
          variables: (t.variables_map ?? {}) as Record<string, string>,
          active: t.active,
        })),
      lastRun: lr
        ? {
            at: lr.started_at,
            dry: lr.dry_run,
            queued: lr.queued,
            scanned: lr.scanned,
            skipped: (lr.skipped ?? {}) as Record<string, number>,
            bySegment: (lr.by_segment ?? {}) as Record<string, number>,
            trigger: lr.trigger,
            mode: lr.send_mode,
            gateOpen: lr.gate_open,
          }
        : null,
      funnel: funnel.get(p.id) ?? { sent: 0, replied: 0, booked: 0, failed: 0 },
    };
  });

  const boot: RecallBootstrap = {
    programmes: views,
    waTemplates: waTemplates.data ?? [],
    channels: channels.data ?? [],
    gateOpen: settings.messagingEnabled(),
    workspaceMode: resolveSendMode(null, settings.value("recall_send_mode")),
    minDays: settings.num("chronic_recall_min_days") ?? null,
    canForceLive: can(member, "clinical.settings.manage"),
    canSeeCalls: can(member, "portal.clinical_followups.read"),
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Recall programmes"
        description="Scheduled messages to patients who are due a check-up, a recall or a greeting. They replace the recall and birthday scenarios that ran in Make."
      >
        <Button asChild variant="outline" size="sm">
          <Link href="/flows">
            <ArrowLeft className="size-4" />
            Flows
          </Link>
        </Button>
        {boot.canSeeCalls ? (
          <Button asChild size="sm">
            <Link href="/flows/recall/calls">
              <PhoneCall className="size-4" />
              Call list
            </Link>
          </Button>
        ) : null}
      </PageHeader>
      <RecallWorkspace boot={boot} />
    </div>
  );
}
