import "server-only";

import { ensureConversation } from "@/lib/inbox/conversations";
import { queueOutbound } from "@/lib/inbox/send";
import {
  ALLOWED_VIEWS,
  ELIGIBLE_FLAG_VIEWS,
  type EligibleRow,
  type ProgrammeRow,
  type RecallDeps,
  type RecallStore,
  type TemplateMapRow,
} from "@/lib/recall/types";
import { parseOrderBy } from "@/lib/recall/engine";
import type { AdminClient } from "@/lib/supabase/admin";
import { renderTemplatePreview } from "@/lib/whatsapp/templates";

/** Just enough of the PostgREST builder for a view whose name is only known at runtime. */
interface LooseQuery {
  eq(column: string, value: unknown): LooseQuery;
  order(column: string, opts: { ascending: boolean }): LooseQuery;
  limit(n: number): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
}

function toProgramme(r: Record<string, unknown>): ProgrammeRow {
  return {
    id: r.id as string,
    org_id: r.org_id as string,
    key: r.key as string,
    name: r.name as string,
    kind: r.kind as string,
    status: r.status as ProgrammeRow["status"],
    eligibility_view: (r.eligibility_view as string | null) ?? null,
    cron_expression: (r.cron_expression as string | null) ?? null,
    repeat_policy: r.repeat_policy as ProgrammeRow["repeat_policy"],
    max_per_run: r.max_per_run as number,
    send_mode_override: (r.send_mode_override as string | null) ?? null,
    requires_marketing_opt_in: r.requires_marketing_opt_in as boolean,
    requires_clinical_consent: r.requires_clinical_consent as boolean,
    config: (r.config as Record<string, unknown>) ?? {},
    last_run_at: (r.last_run_at as string | null) ?? null,
  };
}

export function supabaseRecallStore(admin: AdminClient): RecallStore {
  return {
    async getProgramme(id) {
      const { data } = await admin.from("recall_programmes").select("*").eq("id", id).maybeSingle();
      return data ? toProgramme(data as unknown as Record<string, unknown>) : null;
    },
    async setting(orgId, key) {
      const { data, error } = await admin.rpc("clinical_setting", { p_org: orgId, p_key: key });
      if (error) throw new Error(`clinical_setting(${key}): ${error.message}`);
      return (data as string | null) ?? null;
    },
    async listEligible(p, limit) {
      const view = p.eligibility_view;
      if (!view || !ALLOWED_VIEWS.has(view)) return [];
      // Dynamic view name: the allow-list above is the only reason this is safe.
      let q = (admin as unknown as { from(v: string): { select(c: string): LooseQuery } })
        .from(view)
        .select("*")
        .eq("org_id", p.org_id);
      if (ELIGIBLE_FLAG_VIEWS.has(view)) q = q.eq("eligible", true);
      const order = parseOrderBy(p.config.order_by);
      q = order
        ? q.order(order.column, { ascending: order.ascending })
        : q.order("contact_id", { ascending: true });
      const { data, error } = await q.limit(limit);
      if (error) throw new Error(`eligibility view ${view}: ${error.message}`);
      return (data ?? []) as unknown as EligibleRow[];
    },
    async templateMap(programmeId) {
      const { data } = await admin
        .from("recall_programme_templates")
        .select("*")
        .eq("programme_id", programmeId);
      return (data ?? []).map((t): TemplateMapRow => ({
        id: t.id,
        segment_key: t.segment_key,
        wa_template_id: t.wa_template_id,
        legacy_sanoflow_template_id: t.legacy_sanoflow_template_id,
        variables_map: (t.variables_map as Record<string, string>) ?? {},
        active: t.active,
      }));
    },
    async template(orgId, id) {
      const { data } = await admin
        .from("wa_templates")
        .select("id, name, status, category")
        .eq("id", id)
        .eq("org_id", orgId)
        .maybeSingle();
      return data ?? null;
    },
    async contact(orgId, id) {
      const { data } = await admin
        .from("contacts")
        .select(
          "id, first_name, last_name, full_name, phone_e164, stop_marketing, promotions_opt_in, clinical_messaging_consent, is_test_record",
        )
        .eq("id", id)
        .eq("org_id", orgId)
        .is("deleted_at", null)
        .maybeSingle();
      return data ? { ...data, full_name: data.full_name ?? "" } : null;
    },
    async insertSend(row) {
      const { data, error } = await admin.from("recall_sends").insert(row).select("id").single();
      if (error) {
        if (error.code === "23505") return null;
        throw new Error(`recall_sends insert: ${error.message}`);
      }
      return data;
    },
    async updateSend(id, patch) {
      const { error } = await admin.from("recall_sends").update(patch).eq("id", id);
      if (error) throw new Error(`recall_sends update: ${error.message}`);
    },
    async testContacts(orgId, phones) {
      const out: Array<{ id: string; phone_e164: string }> = [];
      for (const phone of phones) {
        const { data: existing } = await admin
          .from("contacts")
          .select("id")
          .eq("org_id", orgId)
          .eq("phone_e164", phone)
          .is("deleted_at", null)
          .maybeSingle();
        if (existing) {
          out.push({ id: existing.id, phone_e164: phone });
          continue;
        }
        const { data: created } = await admin
          .from("contacts")
          .insert({
            org_id: orgId,
            phone_e164: phone,
            first_name: "Test",
            last_name: "Recipient",
            source: "api",
            is_test_record: true,
          })
          .select("id")
          .single();
        if (created) out.push({ id: created.id, phone_e164: phone });
      }
      return out;
    },
    async tagContact(orgId, contactId, name) {
      const { data: tag } = await admin
        .from("tags")
        .upsert({ org_id: orgId, name, scope: "contact" }, { onConflict: "org_id,scope,name" })
        .select("id")
        .single();
      if (!tag) return;
      await admin
        .from("contact_tags")
        .upsert(
          { org_id: orgId, contact_id: contactId, tag_id: tag.id },
          { onConflict: "contact_id,tag_id", ignoreDuplicates: true },
        );
    },
    async touchProgramme(id, at) {
      await admin.from("recall_programmes").update({ last_run_at: at.toISOString() }).eq("id", id);
    },
  };
}

export function createRecallDeps(admin: AdminClient): RecallDeps {
  return {
    store: supabaseRecallStore(admin),
    sender: {
      async sendTemplate({ orgId, contactId, waTemplateId, values }) {
        const conv = await ensureConversation(admin, { orgId, contactId });
        const { data: tpl } = await admin
          .from("wa_templates")
          .select("components")
          .eq("id", waTemplateId)
          .single();
        const body = tpl ? renderTemplatePreview(tpl.components as never, values).body : null;
        const msg = await queueOutbound(admin, {
          orgId,
          conversationId: conv.id,
          spec: { type: "template", template_id: waTemplateId, values },
          body,
          sentByUserId: null,
          priority: false,
        });
        return { messageId: msg.id };
      },
    },
    now: () => new Date(),
    timezone: "Asia/Dubai",
  };
}
