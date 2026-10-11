"use client";

import Link from "next/link";

import { CustomFieldDialog } from "@/app/(app)/settings/custom-fields/custom-field-dialog";
import { CustomFieldsTable } from "@/app/(app)/settings/custom-fields/custom-fields-table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { CustomFieldDef } from "@/lib/contacts/custom-values";
import type { EnquirySettings } from "@/lib/enquiries/settings";
import type { Lookups, OrgUser, PipelineInfo, TeamInfo } from "@/lib/enquiries/server";

import { GeneralTab } from "./general-tab";
import { PipelinesTab } from "./pipelines-tab";
import { RulesTab, type RuleRow } from "./rules-tab";

export function EnquirySettingsTabs({
  settings,
  pipelines,
  stageCounts,
  rules,
  customFields,
  teams,
  users,
  lookups,
}: {
  settings: EnquirySettings;
  pipelines: PipelineInfo[];
  stageCounts: Record<string, number>;
  rules: RuleRow[];
  customFields: Array<CustomFieldDef & { id: string; entity: string; sort: number }>;
  teams: TeamInfo[];
  users: OrgUser[];
  lookups: Lookups;
}) {
  return (
    <Tabs defaultValue="general">
      <TabsList className="flex-wrap">
        <TabsTrigger value="general">SLA &amp; notifications</TabsTrigger>
        <TabsTrigger value="pipelines">Pipelines &amp; stages</TabsTrigger>
        <TabsTrigger value="rules">Assignment rules</TabsTrigger>
        <TabsTrigger value="fields">Custom fields</TabsTrigger>
        <TabsTrigger value="clinic">Clinic lists</TabsTrigger>
      </TabsList>
      <TabsContent value="general" className="pt-4">
        <GeneralTab settings={settings} teams={teams} users={users} />
      </TabsContent>
      <TabsContent value="pipelines" className="pt-4">
        <PipelinesTab pipelines={pipelines} stageCounts={stageCounts} />
      </TabsContent>
      <TabsContent value="rules" className="pt-4">
        <RulesTab
          rules={rules}
          pipelines={pipelines}
          teams={teams}
          users={users}
          lookups={lookups}
          sources={settings.sources}
        />
      </TabsContent>
      <TabsContent value="fields" className="flex flex-col gap-4 pt-4">
        <div className="flex items-center justify-between gap-4">
          <p className="text-muted-foreground text-sm">
            Extra fields on every enquiry: shown in the drawer, table, filters and exports.
          </p>
          <CustomFieldDialog mode="create" entity="enquiry" />
        </div>
        {customFields.length === 0 ? (
          <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
            No enquiry fields yet. Add one for anything the standard enquiry does not capture
            (insurer, referral code…).
          </p>
        ) : (
          <CustomFieldsTable rows={customFields} entity="enquiry" />
        )}
      </TabsContent>
      <TabsContent value="clinic" className="pt-4">
        <div className="max-w-3xl rounded-xl border p-5 text-sm">
          <p className="font-medium">Locations, departments, services and specialists</p>
          <p className="text-muted-foreground mt-1">
            Enquiries use the same clinic lists as appointments, so they are managed once, in{" "}
            <Link
              href="/settings/appointments"
              className="text-primary underline underline-offset-2"
            >
              Settings → Appointments
            </Link>
            . Inactive entries stay on the enquiries that already use them.
          </p>
        </div>
      </TabsContent>
    </Tabs>
  );
}
