"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  HeartPulse,
  Loader2,
  Pill,
  PhoneCall,
  Stethoscope,
} from "lucide-react";

import { EmptyState } from "@/components/shell/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDate, formatDateTime } from "@/lib/contacts/format";

import {
  getClinicalOverview,
  getContactCare,
  getContactConditions,
  listContactVisits,
  type CareData,
  type ClinicalOverview,
  type ConditionRow,
  type MedicineRow,
  type VisitRow,
} from "./clinical-actions";

/** Patient 360 clinical tabs. Each loads when it is opened (the tab content mounts on open). */

type Res<T> = { ok: true; data: T } | { ok: false; error: string };

function useLoad<T>(load: () => Promise<Res<T>>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    void load().then((r) => {
      if (!alive) return;
      if (r.ok) setData(r.data);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [load]);
  return { data, error };
}

const Spinner = () => (
  <Loader2
    className="text-muted-foreground size-4 animate-spin"
    role="status"
    aria-label="Loading"
  />
);

const label = (s: string | null | undefined) => (s ? s.replace(/_/g, " ") : "");

// ---------------------------------------------------------------------------

export function ClinicalOverviewCard({
  contactId,
  timezone,
}: {
  contactId: string;
  timezone: string;
}) {
  const load = useCallback(() => getClinicalOverview(contactId), [contactId]);
  const { data, error } = useLoad<ClinicalOverview>(load);
  if (error) return <p className="text-destructive text-sm">{error}</p>;
  if (!data) return <Spinner />;
  return (
    <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
      <div>
        <dt className="text-muted-foreground text-xs">Last visit</dt>
        <dd>
          {data.lastVisit ? (
            <>
              {formatDate(data.lastVisit.date, timezone)}
              <span className="text-muted-foreground block text-xs">
                {[data.lastVisit.branch, label(data.lastVisit.department)]
                  .filter(Boolean)
                  .join(" · ") || "Branch not recorded"}
                {data.lastVisit.diagnoses > 0 &&
                  ` · ${data.lastVisit.diagnoses} diagnosis code${data.lastVisit.diagnoses === 1 ? "" : "s"}`}
              </span>
            </>
          ) : (
            "No visits yet"
          )}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground text-xs">Long-term conditions</dt>
        <dd>{data.chronicCount}</dd>
      </div>
      <div>
        <dt className="text-muted-foreground text-xs">Medicines running now</dt>
        <dd>{data.currentMedicines === null ? "Not enough data" : data.currentMedicines}</dd>
      </div>
    </dl>
  );
}

// ---------------------------------------------------------------------------

export function VisitsTab({ contactId, timezone }: { contactId: string; timezone: string }) {
  const [rows, setRows] = useState<VisitRow[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void listContactVisits(contactId, page).then((r) => {
      if (!alive) return;
      setLoading(false);
      if (!r.ok) return setError(r.error);
      setRows((prev) => (page === 0 ? r.data.rows : [...prev, ...r.data.rows]));
      setHasMore(r.data.hasMore);
    });
    return () => {
      alive = false;
    };
  }, [contactId, page]);

  if (error) return <p className="text-destructive text-sm">{error}</p>;
  if (loading && rows.length === 0) return <Spinner />;
  if (rows.length === 0)
    return (
      <EmptyState
        icon={Stethoscope}
        title="No visits recorded"
        description="Visits arrive from Unite once the visit feed is on. A lead without a Unite PIN has none."
      />
    );
  return (
    <div className="flex flex-col gap-2">
      <ul className="divide-y rounded-lg border">
        {rows.map((v) => {
          const expanded = open.has(v.id);
          const panel = `visit-${v.id}`;
          return (
            <li key={v.id}>
              <button
                type="button"
                className="hover:bg-muted/50 flex min-h-11 w-full items-start gap-2 px-3 py-2 text-left text-sm"
                aria-expanded={expanded}
                aria-controls={panel}
                onClick={() =>
                  setOpen((s) => {
                    const n = new Set(s);
                    if (n.has(v.id)) n.delete(v.id);
                    else n.add(v.id);
                    return n;
                  })
                }
              >
                {expanded ? (
                  <ChevronDown className="mt-0.5 size-4 shrink-0" aria-hidden />
                ) : (
                  <ChevronRight className="mt-0.5 size-4 shrink-0" aria-hidden />
                )}
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{formatDate(v.visit_date, timezone)}</span>
                  <span className="text-muted-foreground block text-xs">
                    {[v.branch, v.doctor, label(v.department)].filter(Boolean).join(" · ") ||
                      "No details"}
                  </span>
                  {v.diagnoses.length > 0 && (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {v.diagnoses.slice(0, 3).map((d) => (
                        <Badge key={d.code} variant={d.primary ? "secondary" : "outline"}>
                          {d.code}
                        </Badge>
                      ))}
                      {v.diagnoses.length > 3 && (
                        <Badge variant="outline">+{v.diagnoses.length - 3}</Badge>
                      )}
                    </span>
                  )}
                </span>
                {v.is_test && <Badge variant="warning">Test record</Badge>}
              </button>
              {expanded && (
                <div id={panel} className="bg-muted/30 flex flex-col gap-3 px-4 py-3 text-sm">
                  <section aria-label="Vitals">
                    <h4 className="text-muted-foreground text-xs font-semibold uppercase">
                      Vitals
                    </h4>
                    <p className="tabular-nums">
                      {[
                        v.vitals.bp && `BP ${v.vitals.bp}`,
                        v.vitals.pulse !== null && `Pulse ${v.vitals.pulse}`,
                        v.vitals.temp_c !== null && `Temp ${v.vitals.temp_c} °C`,
                        v.vitals.spo2 !== null && `SpO2 ${v.vitals.spo2}%`,
                        v.vitals.weight_kg !== null && `${v.vitals.weight_kg} kg`,
                        v.vitals.height_cm !== null && `${v.vitals.height_cm} cm`,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "Not recorded"}
                    </p>
                  </section>
                  <section aria-label="Diagnoses">
                    <h4 className="text-muted-foreground text-xs font-semibold uppercase">
                      Diagnoses
                    </h4>
                    {v.diagnoses.length === 0 ? (
                      <p>None recorded</p>
                    ) : (
                      <ul>
                        {v.diagnoses.map((d) => (
                          <li key={d.code}>
                            <span className="tabular-nums">{d.code}</span>
                            {d.name ? ` · ${d.name}` : " · not in the reference list"}
                            {d.primary && <span className="text-muted-foreground"> (primary)</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                  <section aria-label="Prescriptions">
                    <h4 className="text-muted-foreground text-xs font-semibold uppercase">
                      Prescriptions
                    </h4>
                    {v.prescriptions.length === 0 ? (
                      <p>None recorded</p>
                    ) : (
                      <ul>
                        {v.prescriptions.map((p, i) => (
                          <li key={i}>
                            {p.name ?? "Unnamed medicine"}
                            <span className="text-muted-foreground">
                              {[
                                p.dosage,
                                p.duration_days ? `${p.duration_days} days` : null,
                              ].filter(Boolean).length > 0 &&
                                ` · ${[p.dosage, p.duration_days ? `${p.duration_days} days` : null].filter(Boolean).join(", ")}`}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                  <section aria-label="Notes">
                    <h4 className="text-muted-foreground text-xs font-semibold uppercase">Notes</h4>
                    <p className="break-words whitespace-pre-wrap">
                      {v.notes ?? "No cleaned notes available"}
                    </p>
                  </section>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {hasMore && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={loading}
          onClick={() => setPage((p) => p + 1)}
        >
          {loading && <Loader2 className="animate-spin" />} Show older visits
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function ConditionsTab({ contactId, timezone }: { contactId: string; timezone: string }) {
  const load = useCallback(() => getContactConditions(contactId), [contactId]);
  const { data, error } = useLoad(load);
  if (error) return <p className="text-destructive text-sm">{error}</p>;
  if (!data) return <Spinner />;
  const current = data.medicines.filter((m: MedicineRow) => m.current === true);
  const recent = data.medicines.filter((m: MedicineRow) => m.current !== true);
  return (
    <div className="flex flex-col gap-5">
      <section aria-labelledby="cond-h">
        <h3
          id="cond-h"
          className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase"
        >
          Long-term conditions
        </h3>
        {data.conditions.length === 0 ? (
          <EmptyState
            icon={HeartPulse}
            title="No long-term conditions on record"
            description="They are added from the visit diagnoses once the clinical lead has signed off the rule."
          />
        ) : (
          <ul className="divide-y rounded-lg border text-sm">
            {data.conditions.map((c: ConditionRow) => (
              <li key={c.id} className="flex items-start justify-between gap-3 px-3 py-2">
                <span className="min-w-0">
                  <span className="font-medium">{c.name ?? c.code ?? "Condition"}</span>
                  <span className="text-muted-foreground block text-xs">
                    {c.code && <span className="tabular-nums">{c.code} · </span>}
                    {c.last_seen
                      ? `Last seen ${formatDate(c.last_seen, timezone)}`
                      : "Last seen not recorded"}
                    {c.evidence_visits ? ` · ${c.evidence_visits} visits` : ""}
                  </span>
                </span>
                <Badge variant="outline">{label(c.source)}</Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="med-h">
        <h3
          id="med-h"
          className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase"
        >
          Medicines
        </h3>
        {data.medicines.length === 0 ? (
          <EmptyState icon={Pill} title="No prescriptions on record" />
        ) : (
          <>
            <MedicineList title="Running now" rows={current} timezone={timezone} />
            <MedicineList title="Recent or unknown end date" rows={recent} timezone={timezone} />
          </>
        )}
      </section>
      <section aria-labelledby="all-h">
        <h3
          id="all-h"
          className="text-muted-foreground mb-1 text-xs font-semibold tracking-wide uppercase"
        >
          Allergies
        </h3>
        <p className="text-muted-foreground text-sm">
          Pulse does not hold allergies yet. Check with the doctor or in Unite before prescribing.
        </p>
      </section>
    </div>
  );
}

function MedicineList({
  title,
  rows,
  timezone,
}: {
  title: string;
  rows: MedicineRow[];
  timezone: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="mb-3">
      <h4 className="mb-1 text-sm font-medium">{title}</h4>
      <ul className="divide-y rounded-lg border text-sm">
        {rows.map((m) => (
          <li key={m.id} className="px-3 py-2">
            <span className="font-medium">{m.name ?? "Unnamed medicine"}</span>
            <span className="text-muted-foreground block text-xs">
              {[
                m.dosage,
                m.start_date && `from ${formatDate(m.start_date, timezone)}`,
                m.duration_days && `${m.duration_days} days`,
                m.ends_on && `ends ${formatDate(m.ends_on, timezone)}`,
              ]
                .filter(Boolean)
                .join(" · ") || "No details"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function CareTab({ contactId, timezone }: { contactId: string; timezone: string }) {
  const load = useCallback(() => getContactCare(contactId), [contactId]);
  const { data, error } = useLoad<CareData>(load);
  if (error) return <p className="text-destructive text-sm">{error}</p>;
  if (!data) return <Spinner />;
  if (data.followups.length === 0 && data.recalls.length === 0 && data.feedback.length === 0)
    return (
      <EmptyState
        icon={PhoneCall}
        title="No follow-ups yet"
        description="Follow-up calls, recall messages and feedback from the clinical engine appear here as status and dates."
      />
    );
  return (
    <div className="flex flex-col gap-5">
      <CareList title="Follow-up calls" empty="None">
        {data.followups.map((f) => (
          <li key={f.id} className="flex items-center justify-between gap-3 px-3 py-2">
            <span>
              {label(f.category) || "Follow-up"}
              <span className="text-muted-foreground block text-xs">
                {f.due_date ? `Due ${formatDate(f.due_date, timezone)}` : "No due date"} ·{" "}
                {label(f.priority)} priority
              </span>
            </span>
            <Badge variant={f.closed ? "secondary" : "outline"}>
              {f.closed ? "Closed" : label(f.status)}
            </Badge>
          </li>
        ))}
      </CareList>
      <CareList title="Recall messages" empty="None">
        {data.recalls.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 px-3 py-2">
            <span>
              {r.programme ?? "Recall"}
              <span className="text-muted-foreground block text-xs">
                {r.sent_at ? `Sent ${formatDateTime(r.sent_at, timezone)}` : "Not sent"}
                {r.replied ? " · replied" : ""}
                {r.booked ? " · booked" : ""}
              </span>
            </span>
            <Badge variant="outline">{label(r.follow_up_status ?? r.status)}</Badge>
          </li>
        ))}
      </CareList>
      <CareList title="Feedback" empty="None">
        {data.feedback.map((f) => (
          <li key={f.id} className="flex items-center justify-between gap-3 px-3 py-2">
            <span>
              {label(f.stage)}
              <span className="text-muted-foreground block text-xs">
                {formatDate(f.at, timezone)}
                {f.score !== null ? ` · score ${f.score}/10` : ""}
              </span>
            </span>
            {f.needs_review && <Badge variant="warning">Doctor review</Badge>}
          </li>
        ))}
      </CareList>
    </div>
  );
}

function CareList({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode[];
}) {
  return (
    <section>
      <h3 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
        {title}
      </h3>
      {children.length === 0 ? (
        <p className="text-muted-foreground text-sm">{empty}</p>
      ) : (
        <ul className="divide-y rounded-lg border text-sm">{children}</ul>
      )}
    </section>
  );
}
