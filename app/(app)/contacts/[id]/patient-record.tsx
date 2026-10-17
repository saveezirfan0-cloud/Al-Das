"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CalendarClock, Loader2, Megaphone, Users } from "lucide-react";

import { EmptyState } from "@/components/shell/empty-state";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDate, formatDateTime } from "@/lib/contacts/format";
import { LIFECYCLE_LABELS } from "@/lib/contacts/lifecycle";
import type { PatientHeader } from "@/lib/contacts/patient-360-server";
import { formatPhone } from "@/lib/phone";
import { cn } from "@/lib/utils";

import { ContactAppointments } from "../contact-appointments";
import { ContactConversations } from "../contact-conversations";
import { ContactEnquiries } from "../contact-enquiries";
import { ContactHistory, ContactInvoices, ContactTasks } from "../patient-360-tabs";
import { CareTab, ClinicalOverviewCard, ConditionsTab, VisitsTab } from "./clinical-tabs";
import { countRecentCampaigns, listContactCampaigns, type CampaignRow } from "./overview-actions";

const ContactDocuments = dynamic(
  () => import("../documents/documents-tab").then((m) => m.ContactDocuments),
  { ssr: false, loading: () => <Loader2 className="text-muted-foreground size-4 animate-spin" /> },
);

export type RecordAccess = {
  appointments: boolean;
  clinical: boolean;
  conversations: boolean;
  enquiries: boolean;
  enquiriesManage: boolean;
  campaigns: boolean;
  invoices: boolean;
  documents: boolean;
  tasks: boolean;
};

const TONE: Record<"ok" | "warn" | "off", "success" | "warning" | "outline"> = {
  ok: "success",
  warn: "warning",
  off: "outline",
};

const STAGE_VARIANT = {
  lead: "outline",
  new_patient: "success",
  active: "success",
  lapsed: "warning",
  unknown: "outline",
} as const;

export function PatientRecord({
  header,
  access,
  timezone,
  users,
  initialTab,
}: {
  header: PatientHeader;
  access: RecordAccess;
  timezone: string;
  users: Array<{ id: string; label: string }>;
  initialTab: string;
}) {
  const tabs: Array<{ value: string; label: string }> = [
    { value: "overview", label: "Overview" },
    ...(access.appointments ? [{ value: "appointments", label: "Appointments" }] : []),
    ...(access.clinical
      ? [
          { value: "visits", label: "Visits & medical record" },
          { value: "conditions", label: "Conditions & medicines" },
          { value: "care", label: "Care & follow-ups" },
        ]
      : []),
    ...(access.conversations ? [{ value: "conversations", label: "Conversations" }] : []),
    ...(access.enquiries || access.campaigns
      ? [{ value: "marketing", label: "Enquiries & marketing" }]
      : []),
    ...(access.invoices ? [{ value: "billing", label: "Billing & insurance" }] : []),
    ...(access.documents ? [{ value: "documents", label: "Documents" }] : []),
    ...(access.tasks ? [{ value: "tasks", label: "Tasks & notes" }] : []),
    { value: "household", label: "Household" },
  ];
  const [tab, setTab] = useState(
    tabs.some((t) => t.value === initialTab) ? initialTab : "overview",
  );
  const id = header.id;

  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/contacts"
        className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm print:hidden"
      >
        <ArrowLeft className="size-4" aria-hidden /> All patients
      </Link>

      <header
        className="bg-card flex flex-col gap-3 rounded-xl border p-4"
        aria-label="Patient summary"
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="text-xl font-semibold tracking-tight break-words">{header.name}</h2>
            <p className="text-muted-foreground mt-0.5 flex flex-wrap gap-x-3 text-sm">
              {header.age && <span>{header.age}</span>}
              {header.gender && <span className="capitalize">{header.gender}</span>}
              {header.phone && <span className="tabular-nums">{formatPhone(header.phone)}</span>}
              <span>Home branch: {header.homeBranch ?? "Not set"}</span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={STAGE_VARIANT[header.lifecycle]}>
              {LIFECYCLE_LABELS[header.lifecycle]}
            </Badge>
            {header.unitePin ? (
              <Badge variant="secondary">Unite {header.unitePin}</Badge>
            ) : (
              <Badge variant="outline">No Unite PIN</Badge>
            )}
          </div>
        </div>

        {header.chronic && header.chronic.length > 0 && (
          <div className="flex flex-wrap gap-1.5" aria-label="Long-term conditions">
            {header.chronic.map((c) => (
              <Badge key={c} variant="warning">
                {c}
              </Badge>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-1.5" aria-label="Consent">
          {header.consent.map((c) => (
            <Badge key={c.key} variant={TONE[c.tone]}>
              {c.label}
            </Badge>
          ))}
        </div>

        <div
          className={cn(
            "grid grid-cols-1 gap-3 text-sm sm:grid-cols-2",
            header.balance && "lg:grid-cols-3",
          )}
        >
          <div>
            <p className="text-muted-foreground text-xs">Next appointment</p>
            {header.nextAppointment ? (
              <p>
                {formatDateTime(header.nextAppointment.startsAt, timezone)}
                <span className="text-muted-foreground block text-xs">
                  {[
                    header.nextAppointment.doctor,
                    header.nextAppointment.branch,
                    header.nextAppointment.status,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </p>
            ) : (
              <p className="text-muted-foreground">
                {access.appointments ? "None booked" : "Not shown"}
              </p>
            )}
          </div>
          {header.balance && (
            <div>
              <p className="text-muted-foreground text-xs">Open balance</p>
              <p className="tabular-nums">
                {header.balance.due > 0 ? (
                  <span className="font-medium">{aed(header.balance.due)}</span>
                ) : (
                  "Nothing owed"
                )}
                {header.balance.partial && (
                  <span className="text-muted-foreground block text-xs">
                    Insurance invoices are not included (needs claims access).
                  </span>
                )}
                {header.balance.insurerOutstanding > 0 && !header.balance.partial && (
                  <span className="text-muted-foreground block text-xs">
                    Insurers still owe {aed(header.balance.insurerOutstanding)}
                  </span>
                )}
              </p>
            </div>
          )}
          <div>
            <p className="text-muted-foreground text-xs">Household</p>
            <p>
              {header.guardian ? (
                <>
                  Dependant of{" "}
                  <Link className="underline" href={`/contacts/${header.guardian.id}`}>
                    {header.guardian.name}
                  </Link>
                </>
              ) : header.dependants.length > 0 ? (
                `Guardian of ${header.dependants.length} ${header.dependants.length === 1 ? "child" : "dependants"}`
              ) : (
                <span className="text-muted-foreground">None linked</span>
              )}
            </p>
          </div>
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab} className="gap-3">
        <TabsList
          className="h-auto w-full max-w-full flex-nowrap justify-start overflow-x-auto md:flex-wrap"
          aria-label="Patient record sections"
        >
          {tabs.map((t) => (
            <TabsTrigger key={t.value} value={t.value} className="min-h-9 flex-none">
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="flex flex-col gap-4">
          <section className="bg-card rounded-xl border p-4" aria-labelledby="ov-now">
            <h3
              id="ov-now"
              className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase"
            >
              Now
            </h3>
            <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-muted-foreground text-xs">Next appointment</dt>
                <dd>
                  {header.nextAppointment
                    ? formatDateTime(header.nextAppointment.startsAt, timezone)
                    : "None booked"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">Open tasks</dt>
                <dd>{header.openTasks === null ? "Not shown" : header.openTasks}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">Life stage</dt>
                <dd>{LIFECYCLE_LABELS[header.lifecycle]}</dd>
              </div>
              {header.balance && (
                <div>
                  <dt className="text-muted-foreground text-xs">Open balance</dt>
                  <dd className="tabular-nums">
                    {header.balance.due > 0 ? aed(header.balance.due) : "Nothing owed"}
                  </dd>
                </div>
              )}
              {access.campaigns && (
                <div>
                  <dt className="text-muted-foreground text-xs">Campaigns in the last 90 days</dt>
                  <dd>
                    <RecentCampaigns contactId={id} />
                  </dd>
                </div>
              )}
            </dl>
          </section>
          {access.clinical && (
            <section className="bg-card rounded-xl border p-4" aria-labelledby="ov-clin">
              <h3
                id="ov-clin"
                className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase"
              >
                Clinical summary
              </h3>
              <ClinicalOverviewCard contactId={id} timezone={timezone} />
            </section>
          )}
        </TabsContent>

        {access.appointments && (
          <TabsContent value="appointments">
            <ContactAppointments contactId={id} />
          </TabsContent>
        )}
        {access.clinical && (
          <>
            <TabsContent value="visits">
              <VisitsTab contactId={id} timezone={timezone} />
            </TabsContent>
            <TabsContent value="conditions">
              <ConditionsTab contactId={id} timezone={timezone} />
            </TabsContent>
            <TabsContent value="care">
              <CareTab contactId={id} timezone={timezone} />
            </TabsContent>
          </>
        )}
        {access.conversations && (
          <TabsContent value="conversations">
            <ContactConversations contactId={id} />
          </TabsContent>
        )}
        {(access.enquiries || access.campaigns) && (
          <TabsContent value="marketing" className="flex flex-col gap-5">
            {access.enquiries && (
              <section aria-labelledby="mk-enq">
                <h3
                  id="mk-enq"
                  className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase"
                >
                  Enquiries
                </h3>
                <ContactEnquiries
                  contactId={id}
                  timezone={timezone}
                  canView={access.enquiries}
                  canCreate={access.enquiriesManage}
                />
              </section>
            )}
            {access.campaigns && (
              <section aria-labelledby="mk-camp">
                <h3
                  id="mk-camp"
                  className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase"
                >
                  Campaigns received
                </h3>
                <CampaignsList contactId={id} timezone={timezone} />
              </section>
            )}
          </TabsContent>
        )}
        {access.invoices && (
          <TabsContent value="billing">
            <ContactInvoices contactId={id} />
            <p className="text-muted-foreground mt-3 text-xs">
              Insurance claim status per patient is not shown here yet.
            </p>
          </TabsContent>
        )}
        {access.documents && (
          <TabsContent value="documents">
            <ContactDocuments contactId={id} canView={access.documents} timezone={timezone} />
          </TabsContent>
        )}
        {access.tasks && (
          <TabsContent value="tasks" className="flex flex-col gap-5">
            <ContactTasks contactId={id} timezone={timezone} users={users} />
            <section aria-labelledby="tk-hist">
              <h3
                id="tk-hist"
                className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase"
              >
                History
              </h3>
              <ContactHistory contactId={id} timezone={timezone} />
            </section>
          </TabsContent>
        )}
        <TabsContent value="household">
          <HouseholdPanel header={header} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const aed = (n: number) =>
  `AED ${n.toLocaleString("en-AE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function RecentCampaigns({ contactId }: { contactId: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void countRecentCampaigns(contactId).then((r) => {
      if (!alive) return;
      setText(r.ok ? (r.data.count === 0 ? "None" : String(r.data.count)) : "Not shown");
    });
    return () => {
      alive = false;
    };
  }, [contactId]);
  return (
    text ?? <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label="Loading" />
  );
}

function CampaignsList({ contactId, timezone }: { contactId: string; timezone: string }) {
  const [rows, setRows] = useState<CampaignRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => listContactCampaigns(contactId), [contactId]);
  useEffect(() => {
    let alive = true;
    void load().then((r) => {
      if (!alive) return;
      if (r.ok) setRows(r.data);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [load]);
  if (error) return <p className="text-destructive text-sm">{error}</p>;
  if (!rows)
    return <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label="Loading" />;
  if (rows.length === 0)
    return (
      <EmptyState
        icon={Megaphone}
        title="No campaigns"
        description="Campaigns this patient was part of appear here."
      />
    );
  return (
    <ul className="divide-y rounded-lg border text-sm">
      {rows.map((c) => (
        <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2">
          <Link href={`/campaigns?c=${c.campaignId}`} className="font-medium hover:underline">
            {c.name}
          </Link>
          <span className="text-muted-foreground text-xs">
            {c.status.replace(/_/g, " ")}
            {c.sentAt ? ` · ${formatDate(c.sentAt, timezone)}` : ""}
            {c.replied ? " · replied" : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

function HouseholdPanel({ header }: { header: PatientHeader }) {
  if (!header.guardian && header.dependants.length === 0)
    return (
      <EmptyState
        icon={Users}
        title="No household links"
        description="A child or dependant without a phone is linked to a parent or guardian, who then receives their appointment messages."
      />
    );
  const row = (
    m: { id: string; name: string; relationship: string; remindersToGuardian: boolean },
    role: string,
  ) => (
    <li key={m.id} className={cn("flex items-center justify-between gap-3 px-3 py-2")}>
      <span>
        <Link className="font-medium hover:underline" href={`/contacts/${m.id}`}>
          {m.name}
        </Link>
        <span className="text-muted-foreground block text-xs">
          {role} · {m.relationship}
        </span>
      </span>
      {m.remindersToGuardian && (
        <Badge variant="outline" className="gap-1">
          <CalendarClock aria-hidden /> Reminders go to the guardian
        </Badge>
      )}
    </li>
  );
  return (
    <ul className="divide-y rounded-lg border text-sm">
      {header.guardian && row(header.guardian, "Guardian")}
      {header.dependants.map((d) => row(d, "Dependant"))}
    </ul>
  );
}
