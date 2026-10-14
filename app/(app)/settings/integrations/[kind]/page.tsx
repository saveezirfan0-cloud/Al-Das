import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { sealCertificateSummary } from "@/lib/signing/seal-server";
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
import { esignWebhookBase } from "@/lib/integrations/esign/config";
import { readCapiConfig } from "@/lib/integrations/capi/config";
import { mailboxWebhookUrl } from "@/lib/finance/mailbox";
import { CONSENT_BASIS_PHRASE } from "@/lib/integrations/capi/consent";
import { widgetSnippet } from "@/lib/channels/web/snippet";
import { gcalRedirectUri } from "@/lib/integrations/gcal/config";
import { listConnections } from "@/lib/integrations/gcal/server";
import { messagingWebhookBase } from "@/lib/integrations/meta-messaging/config";
import { createAdminClient } from "@/lib/supabase/admin";
import { templateVariables } from "@/lib/whatsapp/templates";
import type { MetaTemplateComponent } from "@/lib/whatsapp/types";

import { savePaymentTemplate } from "../actions";
import { CalendarFeeds } from "../calendar-feeds";
import { CapiPanel } from "../capi-panel";
import { GcalPanel } from "../gcal-panel";
import { WebChatEmbed } from "../web-chat-embed";
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

export default async function IntegrationPage({
  params,
  searchParams,
}: {
  params: Promise<{ kind: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { kind: raw } = await params;
  const query = await searchParams;
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

  // meta ad attribution: who may be included
  let capiPanel: React.ReactNode = null;
  if (kind === "meta_capi") {
    const cfg = readCapiConfig(view.config);
    capiPanel = (
      <CapiPanel
        basis={cfg.consentBasis}
        basisAt={cfg.consentBasisAt}
        phrase={CONSENT_BASIS_PHRASE}
        canManage={canManage}
        exists={view.exists}
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

  // Phase 20e: the website chat's embed line, and the doctors' Google calendars.
  let webChatPanel: React.ReactNode = null;
  if (kind === "web_chat" && canManage) {
    const id = view.exists ? await accountId(admin, member.orgId, kind) : null;
    webChatPanel = (
      <WebChatEmbed enabled={view.enabled} snippet={id ? widgetSnippet(app, id) : null} />
    );
  }
  let gcalPanel: React.ReactNode = null;
  if (kind === "google_calendar" && can(member, "integrations.calendar")) {
    const [connections, { data: specialists }] = await Promise.all([
      listConnections(admin, member.orgId),
      admin
        .from("specialists")
        .select("id, name")
        .eq("org_id", member.orgId)
        .eq("active", true)
        .order("name"),
    ]);
    const byId = new Map(connections.map((c) => [c.specialist_id, c]));
    gcalPanel = (
      <GcalPanel
        enabled={view.enabled}
        redirectUri={gcalRedirectUri(app)}
        result={typeof query.gcal === "string" ? query.gcal : null}
        rows={(specialists ?? []).map((s) => {
          const c = byId.get(s.id);
          return {
            specialistId: s.id,
            name: s.name,
            status: c?.status ?? null,
            lastPullAt: c?.last_pull_at ?? null,
            lastPushAt: c?.last_push_at ?? null,
            lastError: c?.last_error ?? null,
          };
        })}
      />
    );
  }
  // organisation seal: the stored certificate's public details (never the file or its password)
  let sealPanel: React.ReactNode = null;
  if (kind === "document_seal" && canManage) {
    const s = await sealCertificateSummary(admin, member.orgId);
    sealPanel = (
      <Card>
        <CardHeader>
          <CardTitle>Seal certificate</CardTitle>
          <CardDescription>
            {s.info
              ? `${s.sealed} document${s.sealed === 1 ? "" : "s"} sealed so far. Renew the certificate before it expires; documents sealed earlier stay valid.`
              : "No certificate stored yet. Choose the .p12 / .pfx file and type its password under Settings."}
          </CardDescription>
        </CardHeader>
        {s.info && (
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">Subject</dt>
              <dd className="break-all">{s.info.subject}</dd>
              <dt className="text-muted-foreground">Issued by</dt>
              <dd className="break-all">
                {s.info.issuer}
                {s.info.selfSigned
                  ? " (self-signed: readers will say the signer is not trusted)"
                  : ""}
              </dd>
              <dt className="text-muted-foreground">Serial</dt>
              <dd className="font-mono text-xs break-all">{s.info.serialHex}</dd>
              <dt className="text-muted-foreground">Valid</dt>
              <dd>
                {s.info.validFrom.slice(0, 10)} to {s.info.validTo.slice(0, 10)}
              </dd>
              <dt className="text-muted-foreground">Fingerprint</dt>
              <dd className="font-mono text-xs break-all">sha256 {s.info.fingerprint}</dd>
              {s.problems.map((p) => (
                <dd key={p} className="col-span-2 text-red-700">
                  {p}
                </dd>
              ))}
            </dl>
          </CardContent>
        )}
      </Card>
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
        : kind === "esign"
          ? esignWebhookBase(
              app,
              row.view.exists ? await accountId(admin, member.orgId, kind) : "<account id>",
            )
          : kind === "instagram" || kind === "messenger"
            ? messagingWebhookBase(
                app,
                kind,
                row.view.exists ? await accountId(admin, member.orgId, kind) : "<account id>",
              )
            : kind === "finance_mailbox"
              ? mailboxWebhookUrl(
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
      {capiPanel}
      {calendarPanel}
      {webChatPanel}
      {gcalPanel}
      {sealPanel}
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
