import { formatInTimeZone } from "date-fns-tz";

import { PageHeader } from "@/components/shell/page-header";
import { requirePerm } from "@/lib/auth/session";
import { categoryLabel } from "@/lib/documents/categories";
import { readDocumentSettings } from "@/lib/documents/settings";
import {
  findPastRetention,
  loadRetentionPolicies,
  loadStorageUsage,
  sumBytes,
} from "@/lib/documents/server";
import { scannerLabel } from "@/lib/media/server";
import { createAdminClient } from "@/lib/supabase/admin";

import { DocumentsSettings } from "./documents-settings";

export const metadata = { title: "Patient documents" };
export const dynamic = "force-dynamic";

export default async function DocumentSettingsPage() {
  const member = await requirePerm("settings.manage");
  const admin = createAdminClient();
  const today = formatInTimeZone(new Date(), member.org.timezone || "UTC", "yyyy-MM-dd");
  const [policies, usage] = await Promise.all([
    loadRetentionPolicies(admin, member.orgId),
    loadStorageUsage(admin, member.orgId),
  ]);
  const due = await findPastRetention(admin, member.orgId, policies, today, 200);
  const pastByCategory: Record<string, number> = {};
  for (const d of [...due.autoDelete, ...due.review])
    pastByCategory[d.category] = (pastByCategory[d.category] ?? 0) + 1;
  const settings = readDocumentSettings(member.org.settings);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Patient documents"
        description="Referral letters, lab reports, insurance cards and consent forms kept on the patient: switch, reminders, retention and storage."
      />
      <DocumentsSettings
        settings={settings}
        policies={policies.map((p) => ({
          ...p,
          label: categoryLabel(p.category),
          past: pastByCategory[p.category] ?? 0,
        }))}
        usage={{
          ...usage,
          library_total: sumBytes(usage.library),
          documents_total: sumBytes(usage.documents),
        }}
        scanner={scannerLabel()}
      />
    </div>
  );
}
