import "server-only";

import type { EnquiryNotifyEvent } from "@/lib/enquiries/constants";
import { planRecipients } from "@/lib/enquiries/notify-plan";
import { readEnquirySettings } from "@/lib/enquiries/settings";
import { on, type DomainEvent, type DomainEventName } from "@/lib/events/emit";
import { enqueue } from "@/lib/jobs/enqueue";
import { createNotification } from "@/lib/notifications";
import { serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

const EVENT_MAP: Partial<Record<DomainEventName, EnquiryNotifyEvent>> = {
  "enquiry.created": "created",
  "enquiry.assigned": "assigned",
  "enquiry.stage_changed": "stage_changed",
  "enquiry.status_changed": "status_changed",
  "enquiry.sla_breached": "sla_breached",
};

const HEADLINES: Record<EnquiryNotifyEvent, (n: number) => string> = {
  created: (n) => `New enquiry #${n}`,
  assigned: (n) => `Enquiry #${n} was assigned to you`,
  stage_changed: (n) => `Enquiry #${n} moved stage`,
  status_changed: (n) => `Enquiry #${n} changed status`,
  sla_breached: (n) => `Enquiry #${n} has breached its SLA`,
};

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Applies the org's notification rules to an enquiry event. Exported for tests. */
export async function notifyForEvent(event: DomainEvent): Promise<number> {
  const notifyEvent = EVENT_MAP[event.name];
  if (!notifyEvent) return 0;
  const admin = createAdminClient();
  const { data: org } = await admin.from("orgs").select("settings").eq("id", event.orgId).single();
  const rules = readEnquirySettings(org?.settings).notification_rules.filter(
    (r) => r.enabled && r.event === notifyEvent,
  );
  if (rules.length === 0) return 0;

  const teamIds = [...new Set(rules.map((r) => r.team_id).filter((t): t is string => !!t))];
  const teams = new Map<string, string[]>();
  if (teamIds.length) {
    const { data } = await admin
      .from("team_members")
      .select("team_id, user_id")
      .eq("org_id", event.orgId)
      .in("team_id", teamIds);
    for (const m of data ?? []) teams.set(m.team_id, [...(teams.get(m.team_id) ?? []), m.user_id]);
  }

  const recipients = planRecipients({
    event: notifyEvent,
    rules,
    assigneeId: str(event.payload.assignee_id),
    actorId: str(event.payload.actor_id),
    teamMembers: (t) => teams.get(t) ?? [],
  });
  if (recipients.length === 0) return 0;

  const number = Number(event.payload.number ?? 0);
  const enquiryId = str(event.payload.enquiry_id);
  const title = HEADLINES[notifyEvent](number);
  const body = str(event.payload.title);
  const link = `${serverEnv().APP_URL.replace(/\/$/, "")}/enquiries?enquiry=${enquiryId ?? ""}`;

  for (const r of recipients) {
    if (r.inApp) {
      await createNotification(admin, {
        orgId: event.orgId,
        userId: r.userId,
        type: `enquiry.${notifyEvent}`,
        title,
        body,
        payload: { enquiry_id: enquiryId },
      });
    }
    if (r.email) {
      const { data: p } = await admin.from("profiles").select("email").eq("id", r.userId).maybeSingle();
      if (p?.email) {
        // The email carries the number and a link only: titles can contain patient details.
        await enqueue("notifications", {
          type: "email",
          to: p.email,
          subject: title,
          text: `${title}.\n\nOpen it: ${link}`,
        });
      }
    }
  }
  return recipients.length;
}

let registered = false;

/** Idempotent. Listeners never throw into the emitter (emit() catches and logs). */
export function registerEnquiryListeners(): void {
  if (registered) return;
  registered = true;
  for (const name of Object.keys(EVENT_MAP) as DomainEventName[]) {
    on(name, async (event) => {
      await notifyForEvent(event);
    });
  }
}
