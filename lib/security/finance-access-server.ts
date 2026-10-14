import "server-only";

import type { CurrentMember } from "@/lib/auth/session";
import { raiseAlert } from "@/lib/security/alerts";
import { formatIp, ipNetworkLabel } from "@/lib/security/client-ip";
import { financeAccessAlert } from "@/lib/security/finance-access";
import { hashValue } from "@/lib/security/hash";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Records a finance access window refusal as a security alert (one per member per local day; repeats are dropped by
 * the unique dedupe key). Ids, the reason, the /24 network and a keyed hash of the address only. Never throws: a
 * failed alert must not turn a clear refusal page into an error.
 */
export async function noteFinanceDenial(
  member: Pick<CurrentMember, "orgId" | "userId" | "financeAccess" | "clientIp"> & {
    org: Pick<CurrentMember["org"], "timezone">;
  },
): Promise<void> {
  const decision = member.financeAccess;
  if (!decision || decision.allowed) return;
  try {
    const ip = member.clientIp ?? null;
    const draft = financeAccessAlert({
      userId: member.userId,
      reason: decision.reason,
      now: new Date(),
      timeZone: member.org.timezone,
      network: ip ? ipNetworkLabel(ip) : null,
      ipHash: ip ? hashValue(formatIp(ip)) : null,
    });
    await raiseAlert(createAdminClient(), member.orgId, draft);
  } catch (err) {
    console.error("[security] finance access alert failed", {
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}
