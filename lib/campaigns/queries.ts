import "server-only";

import { parseFunnel, type Funnel } from "@/lib/campaigns/funnel";
import { contactDisplayName } from "@/lib/inbox/contact-name";
import type { AdminClient } from "@/lib/supabase/admin";
import type { createClient } from "@/lib/supabase/server";
import type { Tables } from "@/lib/supabase/types";

type UserClient = Awaited<ReturnType<typeof createClient>>;

export const CAMPAIGN_PAGE_SIZE = 25;
export const RECIPIENT_PAGE_SIZE = 50;

const LIST_SELECT =
  "id, name, status, audience_type, scheduled_at, started_at, completed_at, created_at, stats, paused_reason, retry_rounds, retry_round, next_retry_at, error, channels(id, name), wa_templates(id, name, language, category), profiles:profiles!campaigns_created_by_fkey(first_name, last_name)";

export type CampaignListRow = Pick<
  Tables<"campaigns">,
  | "id"
  | "name"
  | "status"
  | "audience_type"
  | "scheduled_at"
  | "started_at"
  | "completed_at"
  | "created_at"
  | "paused_reason"
  | "retry_rounds"
  | "retry_round"
  | "next_retry_at"
  | "error"
> & {
  funnel: Funnel;
  channel: { id: string; name: string } | null;
  template: { id: string; name: string; language: string; category: string } | null;
  createdBy: string;
};

type RawRow = Omit<CampaignListRow, "funnel" | "channel" | "template" | "createdBy"> & {
  stats: unknown;
  channels: { id: string; name: string } | null;
  wa_templates: { id: string; name: string; language: string; category: string } | null;
  profiles: { first_name: string; last_name: string } | null;
};

function toRow(r: RawRow): CampaignListRow {
  const { stats, channels, wa_templates, profiles, ...rest } = r;
  return {
    ...rest,
    funnel: parseFunnel(stats),
    channel: channels,
    template: wa_templates,
    createdBy: profiles ? `${profiles.first_name} ${profiles.last_name}`.trim() : "",
  };
}

export async function listCampaigns(
  supabase: UserClient,
  orgId: string,
  opts: { status?: string; q?: string; page?: number } = {},
): Promise<{ rows: CampaignListRow[]; total: number; page: number }> {
  const page = Math.max(1, opts.page ?? 1);
  let b = supabase
    .from("campaigns")
    .select(LIST_SELECT, { count: "exact" })
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .range((page - 1) * CAMPAIGN_PAGE_SIZE, page * CAMPAIGN_PAGE_SIZE - 1);
  if (opts.status && opts.status !== "all") b = b.eq("status", opts.status);
  const term = opts.q?.replace(/[%,()]/g, " ").trim();
  if (term) b = b.ilike("name", `%${term}%`);
  const { data, count, error } = await b;
  if (error) throw new Error(`listCampaigns: ${error.message}`);
  return { rows: ((data ?? []) as unknown as RawRow[]).map(toRow), total: count ?? 0, page };
}

export type CampaignDetail = CampaignListRow &
  Pick<
    Tables<"campaigns">,
    | "org_id"
    | "channel_id"
    | "template_id"
    | "segment_id"
    | "variable_map"
    | "fallbacks"
    | "guardrails"
    | "retry_delay_minutes"
    | "paused_at"
    | "cancelled_at"
    | "csv_opt_in_confirmed"
  > & { segmentName: string | null };

export async function getCampaignDetail(
  supabase: UserClient,
  admin: AdminClient,
  orgId: string,
  id: string,
): Promise<CampaignDetail | null> {
  const { data, error } = await supabase
    .from("campaigns")
    .select(
      `${LIST_SELECT}, org_id, channel_id, template_id, segment_id, variable_map, fallbacks, guardrails, retry_delay_minutes, paused_at, cancelled_at, csv_opt_in_confirmed, segments(name)`,
    )
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getCampaignDetail: ${error.message}`);
  if (!data) return null;
  const raw = data as unknown as RawRow &
    Pick<
      CampaignDetail,
      | "org_id"
      | "channel_id"
      | "template_id"
      | "segment_id"
      | "variable_map"
      | "fallbacks"
      | "guardrails"
      | "retry_delay_minutes"
      | "paused_at"
      | "cancelled_at"
      | "csv_opt_in_confirmed"
    > & { segments: { name: string } | null };
  const base = toRow(raw);
  // Live numbers while the drawer is open (the stored snapshot lags by up to 30 s).
  const { data: live } = await admin.rpc("campaign_funnel", { p_campaign_id: id });
  if (live) base.funnel = parseFunnel(live);
  return {
    ...base,
    org_id: raw.org_id,
    channel_id: raw.channel_id,
    template_id: raw.template_id,
    segment_id: raw.segment_id,
    variable_map: raw.variable_map,
    fallbacks: raw.fallbacks,
    guardrails: raw.guardrails,
    retry_delay_minutes: raw.retry_delay_minutes,
    paused_at: raw.paused_at,
    cancelled_at: raw.cancelled_at,
    csv_opt_in_confirmed: raw.csv_opt_in_confirmed,
    segmentName: raw.segments?.name ?? null,
  };
}

export type RecipientRow = {
  id: string;
  contactId: string;
  name: string;
  phone: string | null;
  status: string;
  skip_reason: string | null;
  round: number;
  attempts: number;
  sent_at: string | null;
  delivered_at: string | null;
  read_at: string | null;
  replied_at: string | null;
  failed_at: string | null;
  error_code: number | null;
  error_message: string | null;
};

const RECIPIENT_SELECT =
  "id, contact_id, status, skip_reason, round, attempts, sent_at, delivered_at, read_at, replied_at, failed_at, error_code, error_message, contacts(first_name, last_name, wa_profile_name, phone_e164)";

type RawRecipient = Omit<RecipientRow, "contactId" | "name" | "phone"> & {
  contact_id: string;
  contacts: {
    first_name: string;
    last_name: string;
    wa_profile_name: string | null;
    phone_e164: string | null;
  } | null;
};

function toRecipient(r: RawRecipient): RecipientRow {
  const { contacts, contact_id, ...rest } = r;
  return {
    ...rest,
    contactId: contact_id,
    name: contacts ? contactDisplayName(contacts) : "Unknown",
    phone: contacts?.phone_e164 ?? null,
  };
}

export async function listRecipients(
  supabase: UserClient,
  campaignId: string,
  opts: { status?: string; replied?: boolean; page?: number; pageSize?: number } = {},
): Promise<{ rows: RecipientRow[]; total: number; page: number; pageSize: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = opts.pageSize ?? RECIPIENT_PAGE_SIZE;
  let b = supabase
    .from("campaign_recipients")
    .select(RECIPIENT_SELECT, { count: "exact" })
    .eq("campaign_id", campaignId)
    .order("created_at")
    .order("id")
    .range((page - 1) * pageSize, page * pageSize - 1);
  b = applyRecipientFilter(b, opts);
  const { data, count, error } = await b;
  if (error) throw new Error(`listRecipients: ${error.message}`);
  return {
    rows: ((data ?? []) as unknown as RawRecipient[]).map(toRecipient),
    total: count ?? 0,
    page,
    pageSize,
  };
}

/** Status filter shared by the table and the CSV report: sent/delivered/read are cumulative like the funnel. */
export function applyRecipientFilter<
  B extends {
    in(c: string, v: string[]): B;
    eq(c: string, v: string): B;
    not(c: string, op: string, v: null): B;
  },
>(b: B, opts: { status?: string; replied?: boolean }): B {
  let q = b;
  switch (opts.status) {
    case "sent":
      q = q.in("status", ["sent", "delivered", "read"]);
      break;
    case "delivered":
      q = q.in("status", ["delivered", "read"]);
      break;
    case "pending":
      q = q.in("status", ["pending", "queued"]);
      break;
    case "queued":
    case "read":
    case "failed":
    case "skipped":
      q = q.eq("status", opts.status);
      break;
  }
  if (opts.replied) q = q.not("replied_at", "is", null);
  return q;
}

/** Streams every recipient in pages for the CSV report. */
export async function* reportRecipients(
  supabase: UserClient,
  campaignId: string,
): AsyncGenerator<RecipientRow[]> {
  const pageSize = 1000;
  for (let page = 1; ; page++) {
    const { rows } = await listRecipients(supabase, campaignId, { page, pageSize });
    if (rows.length === 0) return;
    yield rows;
    if (rows.length < pageSize) return;
  }
}

/** Campaign messages sent this calendar month (UTC) — the "quota" meter. */
export async function sentThisMonth(supabase: UserClient, orgId: string): Promise<number> {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  const { count } = await supabase
    .from("campaign_recipients")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .gte("sent_at", start.toISOString());
  return count ?? 0;
}
