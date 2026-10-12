import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shell/page-header";
import { can, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { serverEnv } from "@/lib/env";
import { listFeeds } from "@/lib/integrations/calendar/feed-server";
import {
  integrationDef,
  isIntegrationKind,
  type IntegrationKind,
} from "@/lib/integrations/catalog";
import { loadIntegrationHealth, loadUsage } from "@/lib/integrations/health-server";
import { PAYMENT_VALUE_SOURCES, readPaymentsConfig } from "@/lib/integrations/payments/config";
import { paymentWebhookBase } from "@/lib/integrations/payments/config";
import { loadPaymentTemplate, templateReadiness } from "@/lib/integrations/payments/request-server";
import { smsCallbackBase } from "@/lib/integrations/sms/config";
import { readinessProblems } from "@/lib/integrations/readiness";
import { createAdminClient } from "@/lib/supabase/admin";
import { templateVariables } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

import { CalendarFeeds } from "../calendar-feeds";
import { IntegrationPanel } from "../integration-panel";
import { PaymentTemplate } from "../payment-template";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  return { title: isIntegrationKind(kind) ? integrationDef(kind).title : "Integration" };
}

export default async function IntegrationPage({ params }: { params: Promise<{ kind: string }> }) {
  const { kind: raw } = await params;
  if (!isIntegrationKind(raw)) notFound();
  const kind: IntegrationKind = raw;
  const def = integrationDef(kind);
  const member = await requireMember();
  const canManage = can(member, "integrations.manage");
  if (!canManage && !can(member, def.viewPermission)) throw new ForbiddenError(def.viewPermission);

  const admin = createAdminClient();
  const [health, usage] = await Promise.all([
    loadIntegrationHealth(admin, member.orgId),
    loadUsage(admin, member.orgId, kind),
  ]);
  const row = health.find((h) => h.kind === kind)!;
  const view = row.view;
  const app = serverEnv().APP_URL;

  // payments: the template picker and its mapping
  let paymentPanel: React.ReactNode = null;
  let templateState: ReturnType<typeof templateReadiness> = null;
  if (kind === "payments") {
    const cfg = readPaymentsConfig(view.config);
    const [{ data: templates }, current] = await Promise.all([
      admin
        .from("wa_templates")
        .select("id, name, language, status, category, components")
        .eq("org_id", member.orgId)
        .eq("status", "APPROVED")
        .eq("category", "UTILITY")
        .is("archived_at", null)
        .order("name")
        .limit(200),
      loadPaymentTemplate(admin, member.orgId, cfg.templateId),
    ]);
    templateState = templateReadiness(current, cfg);
    const options = (templates ?? []).map((t) => ({
      id: t.id,
      label: `${t.name} (${t.language})`,
      variables: templateVariables(t.components as unknown as MetaTemplateComponent[]).map((v) => ({
        key: v.key,
        supported: v.kind === "text" && v.component !== "button",
        example: v.example,
      })),
    }));
    if (current && !options.some((o) => o.id === current.id)) {
      options.unshift({
        id: current.id,
        label: `${current.name} (not approved or not Utility)`,
        variables: templateVariables(current.components as MetaTemplateComponent[]).map((v) => ({
          key: v.key,
          supported: v.kind === "text" && v.component !== "button",
          example: v.example,
        })),
      });
    }
    paymentPanel = (
      <PaymentTemplate
        canManage={canManage}
        options={options}
        templateId={cfg.templateId}
        variableMap={cfg.variableMap}
        sources={PAYMENT_VALUE_SOURCES.map((s) => ({ key: s.key, label: s.label }))}
      />
    );
  }

  // calendar: feeds, doctors, people
  let calendarPanel: React.ReactNode = null;
  if (kind === "calendar_ics" && can(member, "integrations.calendar")) {
    const [feeds, { data: specialists }, { data: members }] = await Promise.all([
      listFeeds(admin, member.orgId),
      admin
        .from("specialists")
        .select("id, name, active")
        .eq("org_id", member.orgId)
        .eq("active", true)
        .order("name"),
      admin
        .from("memberships")
        .select("user_id, profiles(first_name, last_name)")
        .eq("org_id", member.orgId)
        .eq("status", "active"),
    ]);
    calendarPanel = (
      <CalendarFeeds
        enabled={view.enabled}
        feeds={feeds}
        specialists={(specialists ?? []).map((s) => ({ id: s.id, name: s.name }))}
        people={(members ?? []).map((m) => ({
          id: m.user_id,
          name:
            [m.profiles?.first_name, m.profiles?.last_name].filter(Boolean).join(" ") || "Member",
        }))}
        selfId={member.userId}
        canSeeEveryone={canManage}
      />
    );
  }

  const problems = canManage
    ? readinessProblems({
        kind,
        provider: view.provider,
        config: view.config,
        secretsStored: view.secretsStored,
        template: templateState,
      })
    : [];

  const webhookUrl =
    kind === "sms"
      ? smsCallbackBase(
          app,
          row.view.exists ? await accountId(admin, member.orgId, kind) : "<account id>",
        )
      : kind === "payments"
        ? paymentWebhookBase(
            app,
            row.view.exists ? await accountId(admin, member.orgId, kind) : "<account id>",
          )
        : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={def.title} description={def.description} />
      <IntegrationPanel
        kind={kind}
        def={{
          title: def.title,
          providers: def.providers.map((p) => ({
            id: p.id,
            label: p.label,
            fields: [...p.fields],
          })),
          commonFields: [...def.commonFields],
          confirmWord: def.confirmWord,
          consequence: def.consequence,
          outbound: def.outbound,
        }}
        view={view}
        state={row.state}
        problems={problems}
        usage={usage}
        calls24h={row.calls24h}
        failed24h={row.failed24h}
        canManage={canManage}
        webhookUrl={webhookUrl}
      />
      {paymentPanel}
      {calendarPanel}
    </div>
  );
}

async function accountId(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  kind: IntegrationKind,
): Promise<string> {
  const { data } = await admin
    .from("integration_accounts")
    .select("id")
    .eq("org_id", orgId)
    .eq("kind", kind)
    .maybeSingle();
  return data?.id ?? "<account id>";
}
