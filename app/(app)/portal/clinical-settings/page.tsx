import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { ClinicalSettings, type SettingRow } from "@/lib/clinical/settings";
import { createAdminClient } from "@/lib/supabase/admin";

import { SettingsBoard, type SettingItem } from "./settings-board";

export const metadata = { title: "Clinical settings" };

export default async function ClinicalSettingsPage() {
  const member = await requirePerm("portal.clinical_settings.read");
  const admin = createAdminClient();
  const canManage = can(member, "clinical.settings.manage");

  let { data: rows } = await admin
    .from("clinical_settings")
    .select("*")
    .eq("org_id", member.orgId)
    .order("category")
    .order("label");
  if (!rows?.length && canManage) {
    // First visit: create the rows from the audited Airtable thresholds. All start unsigned.
    await admin.rpc("seed_clinical_settings", { p_org: member.orgId });
    ({ data: rows } = await admin
      .from("clinical_settings")
      .select("*")
      .eq("org_id", member.orgId)
      .order("category")
      .order("label"));
  }

  const items: SettingItem[] = (rows ?? []).map((r) => ({
    key: r.key,
    label: r.label,
    category: r.category,
    valueType: r.value_type,
    proposed: r.proposed_value,
    approved: r.approved_value,
    live: r.live_value,
    status: r.sign_off_status,
    owner: r.owner,
    notes: r.notes,
    signedBy: r.signed_by,
    signedAt: r.signed_at,
  }));
  const gateOn = new ClinicalSettings((rows ?? []) as SettingRow[]).messagingEnabled();
  const blocking = items.filter((i) => i.status === "blocking").length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Clinical settings"
        description="Thresholds and term lists the clinical rules use. A rule never fires on an unsigned value."
      />
      <Alert variant={gateOn ? "default" : "destructive"}>
        <AlertTitle>Patient-facing clinical messages are {gateOn ? "ON" : "OFF"}</AlertTitle>
        <AlertDescription>
          {gateOn
            ? "Approved templates may be sent to patients who have consented. Revoke the sign-off on clinical_messaging_enabled to stop everything immediately."
            : "Nothing clinical is sent to patients. Internal follow-ups still work. Turning this on needs a signed-off clinical_messaging_enabled below."}
          {blocking > 0 &&
            ` ${blocking} blocking setting${blocking === 1 ? " is" : "s are"} unsigned.`}
        </AlertDescription>
      </Alert>
      <SettingsBoard
        items={items}
        canManage={canManage}
        defaultSigner={[member.profile.first_name, member.profile.last_name]
          .filter(Boolean)
          .join(" ")}
      />
    </div>
  );
}
