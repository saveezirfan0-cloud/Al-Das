import "server-only";

import { buildDigests, type DigestMember, type OpenException } from "@/lib/finance/digest";
import { enqueue } from "@/lib/jobs/enqueue";
import type { AdminClient } from "@/lib/supabase/admin";

export type RuleRunResult = Record<string, { opened?: number; closed?: number; skipped?: boolean }>;

/** Runs the exception rules for one org (idempotent). Service role: callers must have checked can(). */
export async function runRulesForOrg(admin: AdminClient, orgId: string): Promise<RuleRunResult> {
  const { data, error } = await admin.rpc("fin_run_exception_rules", { p_org_id: orgId });
  if (error) throw new Error(`run exception rules: ${error.message}`);
  return (data ?? {}) as RuleRunResult;
}

/** Queues the daily digest e-mails when the org switched them on. Returns how many were queued. */
export async function sendDigestForOrg(admin: AdminClient, orgId: string): Promise<number> {
  const { data: settings } = await admin
    .from("fin_capture_settings")
    .select("digest_enabled")
    .eq("org_id", orgId)
    .maybeSingle();
  if (!settings?.digest_enabled) return 0;

  const { data: open, error } = await admin
    .from("ops_exceptions")
    .select("rule_code, owner_role, due_date, status")
    .eq("org_id", orgId)
    .in("status", ["open", "in_progress"])
    .limit(20_000);
  if (error) throw new Error(`digest exceptions: ${error.message}`);

  const { data: memberships, error: mErr } = await admin
    .from("memberships")
    .select("user_id, roles(permissions), profiles(email, first_name)")
    .eq("org_id", orgId)
    .eq("status", "active");
  if (mErr) throw new Error(`digest members: ${mErr.message}`);

  const members: DigestMember[] = (memberships ?? []).flatMap((m) => {
    const perms = Array.isArray(m.roles?.permissions)
      ? (m.roles.permissions as unknown[]).filter((p): p is string => typeof p === "string")
      : [];
    return m.profiles?.email
      ? [
          {
            userId: m.user_id,
            email: m.profiles.email,
            firstName: m.profiles.first_name,
            permissions: perms,
          },
        ]
      : [];
  });

  const emails = buildDigests(
    (open ?? []) as OpenException[],
    members,
    process.env.APP_URL ?? "http://localhost:3000",
  );
  for (const e of emails)
    await enqueue("notifications", { type: "email", to: e.to, subject: e.subject, text: e.text });
  return emails.length;
}
