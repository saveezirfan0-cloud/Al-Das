import "server-only";

import type { AdminClient } from "@/lib/supabase/admin";

const FORWARD: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };

/** Mirrors message delivery state onto recall_sends (status only moves forward; failed is terminal). */
export async function syncSendStatuses(admin: AdminClient, limit = 500): Promise<number> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data: sends } = await admin
    .from("recall_sends")
    .select("id, status, message_id")
    .in("status", ["queued", "sent", "delivered"])
    .not("message_id", "is", null)
    .gte("created_at", since)
    .limit(limit);
  if (!sends?.length) return 0;
  const { data: msgs } = await admin
    .from("messages")
    .select("id, status")
    .in(
      "id",
      sends.map((s) => s.message_id!),
    );
  const byId = new Map((msgs ?? []).map((m) => [m.id, m.status]));
  let updated = 0;
  for (const s of sends) {
    const next = byId.get(s.message_id!);
    if (!next) continue;
    const forward =
      next === "failed" ||
      (FORWARD[next] !== undefined && FORWARD[next]! > (FORWARD[s.status] ?? 0));
    if (!forward) continue;
    const { error } = await admin
      .from("recall_sends")
      .update({ status: next as never })
      .eq("id", s.id);
    if (!error) updated += 1;
  }
  return updated;
}
