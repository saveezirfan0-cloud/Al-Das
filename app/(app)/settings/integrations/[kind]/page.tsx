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
import { loadPaymentTemplate } from "@/lib/integrations/payments/request-server";
import { smsCallbackBase } from "@/lib/integrations/sms/config";
import { readinessProblems } from "@/lib/integrations/readiness";
import { loadReadinessInput } from "@/lib/integrations/readiness-server";
import { readReviewConfig, REVIEW_VALUE_SOURCES } from "@/lib/integrations/reviews/config";
import { loadReviewStats, loadReviewTemplate } from "@/lib/integrations/reviews/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { templateVariables } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

import { savePaymentTemplate } from "../actions";
import { CalendarFeeds } from "../calendar-feeds";
import { IntegrationPanel } from "../integration-panel";
import { saveReviewTemplate } from "../review-actions";
import { ReviewLinks } from "../review-links";
import { ReviewStatsCard } from "../review-stats";
import { TemplateMapPanel } from "../template-map-panel";

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
  if (kind === "payments") {
    const cfg = readPaymentsConfig(view.config);
    const { options } = await templateOptionsFor(admin, member.orgId, {
      id: cfg.templateId,
      category: "UTILITY",
      load: loadPaymentTemplate,
    });
    paymentPanel = (
      <TemplateMapPanel
        title="Payment message"
        description="The approved WhatsApp template (Utility category) that carries the payment link. Map one variable to the payment link and every other variable to a value. Only text variables in the header or body are supported."
        idPrefix="pay"
        save={savePaymentTemplate}
        canManage={canManage}
        options={options}
        templateId={cfg.templateId}
        variableMap={cfg.variableMap}
        sources={PAYMENT_VALUE_SOURCES.map((s) => ({ key: s.key, label: s.label }))}
      />
    );
  }

  // google reviews: template, links per location, 30-day counters
  let reviewsPanel: React.ReactNode = null;
  if (kind === "google_reviews") {
    const cfg = readReviewConfig(view.config);
    const [{ options }, { data: locations }, stats] = await Promise.all([
      templateOptionsFor(admin, member.orgId, {
        id: cfg.templateId,
        category: null,
        load: loadReviewTemplate,
      }),
      admin
        .from("locations")
        .select("id, name, review_url")
        .eq("org_id", member.orgId)
        .eq("active", true)
        .order("name"),
      canManage ? loadReviewStats(admin, member.orgId) : Promise.resolve(null),
    ]);
    reviewsPanel = (
      <>
        <TemplateMapPanel
          title="Review message"
          description="The approved WhatsApp template that carries the review link (any category: Meta usually treats it as Marketing, so only patients who opted in are asked). Map one variable to the review link and every other variable to a value. Only text variables in the header or body are supported."
          idPrefix="review"
          save={saveReviewTemplate}
          canManage={canManage}
          options={options}
          templateId={cfg.templateId}
          variableMap={cfg.variableMap}
          sources={REVIEW_VALUE_SOURCES.map((s) => ({ key: s.key, label: s.label }))}
        />
        <ReviewLinks
          canManage={canManage}
          locations={(locations ?? []).map((l) => ({
            id: l.id,
            name: l.name,
            url: l.review_url ?? "",
          }))}
        />
        {stats && <ReviewStatsCard stats={stats} />}
      </>
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
    ? readinessProblems(await loadReadinessInput(admin, member.orgId, kind, view))
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
      {reviewsPanel}
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

type TemplateRowLike = {
  id: string;
  name: string;
  status: string;
  category: string;
  components: unknown;
};

/** The approved templates an integration may choose from (plus the one already chosen, flagged when it no longer qualifies). */
async function templateOptionsFor<T extends TemplateRowLike>(
  admin: ReturnType<typeof createAdminClient>,
  orgId: string,
  o: {
    id: string | null;
    category: string | null;
    load: (
      admin: ReturnType<typeof createAdminClient>,
      orgId: string,
      id: string | null,
    ) => Promise<T | null>;
  },
) {
  let query = admin
    .from("wa_templates")
    .select("id, name, language, status, category, components")
    .eq("org_id", orgId)
    .eq("status", "APPROVED")
    .is("archived_at", null)
    .order("name")
    .limit(200);
  if (o.category) query = query.eq("category", o.category);
  const [{ data: templates }, current] = await Promise.all([query, o.load(admin, orgId, o.id)]);
  const variables = (components: unknown) =>
    templateVariables(components as MetaTemplateComponent[]).map((v) => ({
      key: v.key,
      supported: v.kind === "text" && v.component !== "button",
      example: v.example,
    }));
  const options = (templates ?? []).map((t) => ({
    id: t.id,
    label: `${t.name} (${t.language})`,
    variables: variables(t.components),
  }));
  if (current && !options.some((x) => x.id === current.id)) {
    options.unshift({
      id: current.id,
      label: `${current.name} (not approved${o.category ? " or not " + o.category.toLowerCase() : ""})`,
      variables: variables(current.components),
    });
  }
  return { options, current };
}
