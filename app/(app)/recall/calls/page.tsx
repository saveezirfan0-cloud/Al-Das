import { PageHeader } from "@/components/shell/page-header";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { CallList, type CallRow } from "./call-list";

export const metadata = { title: "Recall call list" };

export default async function CallListPage() {
  const member = await requirePerm("campaigns.view");
  const admin = createAdminClient();
  const [{ data: rows }, { data: programmes }] = await Promise.all([
    admin
      .from("v_recall_call_list")
      .select("recall_send_id, programme_id, contact_id, sent_at, follow_up_status, days_waiting, workdays_waiting, overdue, call_now")
      .eq("org_id", member.orgId)
      .eq("call_now", true)
      .order("sent_at", { ascending: true })
      .limit(200),
    admin.from("recall_programmes").select("id, name").eq("org_id", member.orgId),
  ]);
  const contactIds = [...new Set((rows ?? []).map((r) => r.contact_id).filter((x): x is string => Boolean(x)))];
  const { data: contacts } = contactIds.length ? await admin.from("contacts").select("id, first_name, last_name").in("id", contactIds) : { data: [] };
  const name = new Map((contacts ?? []).map((c) => [c.id, `${c.first_name} ${c.last_name}`.trim() || "Unnamed"]));
  const prog = new Map((programmes ?? []).map((p) => [p.id, p.name]));

  const list: CallRow[] = (rows ?? []).map((r) => ({
    id: r.recall_send_id ?? "",
    contactId: r.contact_id ?? "",
    patient: name.get(r.contact_id ?? "") ?? "Unnamed",
    programme: prog.get(r.programme_id ?? "") ?? "—",
    sentAt: r.sent_at ?? "",
    daysWaiting: r.days_waiting ?? 0,
    overdue: Boolean(r.overdue),
    status: (r.follow_up_status as CallRow["status"]) ?? null,
  }));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Recall call list" description="Patients who were messaged for real and have not replied after the waiting period. Call them, then record the outcome." />
      <CallList rows={list} canEdit={can(member, "portal.recall_sends.write")} />
    </div>
  );
}
