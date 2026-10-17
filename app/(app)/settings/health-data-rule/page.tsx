import { PageHeader } from "@/components/shell/page-header";
import { requirePerm } from "@/lib/auth/session";
import {
  CAPACITY_LABEL,
  CONSENT_RULE_TEXT,
  CONSENT_RULE_VERSION,
  consentRuleHash,
  consentRuleStatus,
  readConsentRule,
  SIGNER_CAPACITIES,
} from "@/lib/campaigns/consent-rule";
import { createAdminClient } from "@/lib/supabase/admin";

import { RuleSignoff } from "./rule-signoff";

export const metadata = { title: "Health data in campaigns" };
export const dynamic = "force-dynamic";

export default async function HealthDataRulePage() {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const { data: org } = await admin.from("orgs").select("settings").eq("id", member.orgId).single();
  const settings = readConsentRule(org?.settings);
  const hash = consentRuleHash();
  const status = consentRuleStatus(settings, hash);

  const ids = SIGNER_CAPACITIES.map((c) => settings[c]?.user_id).filter((x): x is string => !!x);
  const { data: people } = ids.length
    ? await admin.from("profiles").select("id, first_name, last_name, email").in("id", ids)
    : { data: [] };
  const nameOf = (id: string) => {
    const p = people?.find((x) => x.id === id);
    return `${p?.first_name ?? ""} ${p?.last_name ?? ""}`.trim() || p?.email || "A team member";
  };

  const rows = SIGNER_CAPACITIES.map((capacity) => {
    const s = settings[capacity];
    return {
      capacity,
      label: CAPACITY_LABEL[capacity],
      signedBy: s ? nameOf(s.user_id) : null,
      signedAt: s?.at ?? null,
      current: s?.rule_hash === hash,
      mine: s?.user_id === member.userId,
    };
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Health data in campaigns"
        description="The rule that keeps health information out of marketing. The clinical lead and management sign the wording; the system already enforces it."
      />
      <RuleSignoff
        version={CONSENT_RULE_VERSION}
        text={CONSENT_RULE_TEXT}
        hashShort={hash.slice(0, 12)}
        state={status.state}
        rows={rows}
      />
    </div>
  );
}
