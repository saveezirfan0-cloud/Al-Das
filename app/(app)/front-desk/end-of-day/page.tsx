import Link from "next/link";
import { formatInTimeZone } from "date-fns-tz";

import { PageHeader } from "@/components/shell/page-header";
import { PrintButton } from "@/components/shell/print-button";
import { Button } from "@/components/ui/button";
import { can } from "@/lib/auth/can";
import { memberBranchView } from "@/lib/branches/guard";
import { requirePerm } from "@/lib/auth/session";
import { cashupHref, summariseDayByBranch } from "@/lib/front-desk/day-summary";
import { ADVICE_LABEL, sheetSummary } from "@/lib/front-desk/end-of-day";
import { loadEndOfDay } from "@/lib/front-desk/end-of-day-server";
import { loadBoardRows, todayIn } from "@/lib/front-desk/server";
import { formatPhone } from "@/lib/phone";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "End of day" };

export default async function EndOfDayPage() {
  const member = await requirePerm("frontdesk.use");
  if (!can(member, "appointments.view")) {
    return (
      <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
        The end of day sheet needs permission to view appointments.
      </p>
    );
  }
  const tz = member.org.timezone || "Asia/Dubai";
  const admin = createAdminClient();
  // Phase B: the sheet keeps to the branch the desk is showing (or every branch the member may see).
  const branch = await memberBranchView(admin, member);
  const today = todayIn(tz);
  const [data, todayRows, { data: codes }] = await Promise.all([
    loadEndOfDay(admin, member.orgId, tz, today, branch.filterIds),
    // Phase E: how today went at each branch (counts only), from today's board.
    loadBoardRows(admin, member.orgId, tz, today, null, branch.filterIds),
    admin.from("locations").select("id, branch_code").eq("org_id", member.orgId),
  ]);
  const byBranch = summariseDayByBranch(todayRows);
  const canCashup = can(member, "finance.cashup.manage");
  const codeOf = new Map((codes ?? []).map((l) => [l.id, l.branch_code]));
  await recordAccess(admin, member, {
    entity: "appointment",
    action: "list",
    detail: { screen: "end_of_day", rows: data.unconfirmed.length + data.unanswered.length },
  });
  const time = (iso: string) => formatInTimeZone(new Date(iso), tz, "h:mm a");
  const day = (d: string) => formatInTimeZone(new Date(`${d}T12:00:00Z`), "UTC", "EEEE d MMMM");

  return (
    <div className="flex flex-col gap-6 print:gap-4 print:text-[11pt]">
      <div className="print:hidden">
        <PageHeader title="End of day" description="What to hand over before you go home.">
          <PrintButton label="Print the sheet" />
          <Button size="sm" variant="outline" asChild>
            <Link href="/front-desk">Back to the desk</Link>
          </Button>
        </PageHeader>
      </div>

      <header className="hidden print:block">
        <h1 className="text-xl font-semibold">
          {member.org.name} · End of day · {day(data.date)}
        </h1>
      </header>
      <p className="text-muted-foreground text-sm print:text-black">
        {sheetSummary({
          unconfirmed: data.unconfirmed.length,
          unanswered: data.unanswered.length,
          openCalls: data.openCalls.length,
          failed: data.failed.length,
        })}
      </p>

      <section className="break-inside-avoid" aria-labelledby="eod-branches">
        <h2 id="eod-branches" className="mb-2 border-b pb-1 text-base font-semibold">
          Today by branch
        </h2>
        {byBranch.branches.length === 0 ? (
          <p className="text-muted-foreground text-sm print:text-black">
            No appointments today in the branches you see.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground text-left text-xs print:text-black">
                  <th className="py-1 pr-3">Branch</th>
                  <th className="py-1 pr-3 text-right">Booked</th>
                  <th className="py-1 pr-3 text-right">Seen</th>
                  <th className="py-1 pr-3 text-right">No-shows</th>
                  <th className="py-1 pr-3 text-right">Cancelled</th>
                  <th className="py-1 pr-3 text-right">Walk-ins</th>
                  <th className="py-1 pr-3 text-right">Median wait</th>
                  <th className="py-1 print:hidden">
                    <span className="sr-only">Cash-up</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...byBranch.branches, ...(byBranch.branches.length > 1 ? [byBranch.total] : [])].map(
                  (b) => {
                    const href = b.location_id
                      ? cashupHref(codeOf.get(b.location_id), today, canCashup)
                      : null;
                    const isTotal = b === byBranch.total;
                    return (
                      <tr
                        key={b.location_id ?? (isTotal ? "total" : "none")}
                        className={isTotal ? "border-t-2 font-medium" : "border-t"}
                      >
                        <td className="py-1.5 pr-3">{b.location_name}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{b.booked}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{b.seen}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{b.noShows}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{b.cancelled}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">{b.walkIns}</td>
                        <td className="py-1.5 pr-3 text-right tabular-nums">
                          {b.medianWaitMin === null ? "—" : `${b.medianWaitMin} min`}
                        </td>
                        <td className="py-1.5 print:hidden">
                          {href && (
                            <Link className="text-primary underline" href={href}>
                              Cash-up
                            </Link>
                          )}
                        </td>
                      </tr>
                    );
                  },
                )}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-muted-foreground mt-1 text-xs print:text-black">
          Seen counts patients who reached the doctor. Waiting time runs from Arrived to With doctor.
          {byBranch.total.stillWaiting > 0 &&
            ` ${byBranch.total.stillWaiting} still waiting now.`}
          {!canCashup && " The cash-up is done by Finance (finance.cashup.manage)."}
        </p>
      </section>

      <Section
        title={`Unconfirmed for tomorrow, ${day(data.tomorrow)}`}
        empty="Everyone booked for tomorrow has confirmed."
        count={data.unconfirmed.length}
      >
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground text-left text-xs print:text-black">
              <th className="py-1 pr-3">Time</th>
              <th className="py-1 pr-3">Patient</th>
              <th className="py-1 pr-3">Doctor</th>
              <th className="py-1 pr-3">Phone</th>
              <th className="py-1">Do this</th>
            </tr>
          </thead>
          <tbody>
            {data.unconfirmed.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="py-1.5 pr-3 tabular-nums">{time(r.starts_at)}</td>
                <td className="py-1.5 pr-3">{r.patient_name}</td>
                <td className="py-1.5 pr-3">{r.specialist_name ?? ""}</td>
                <td className="py-1.5 pr-3">{r.phone ? formatPhone(r.phone) : ""}</td>
                <td className="py-1.5">{ADVICE_LABEL[r.advice]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section
        title="Conversations waiting for a reply"
        empty="Every conversation has been answered."
        count={data.unanswered.length}
      >
        <ul className="divide-y text-sm">
          {data.unanswered.map((c) => (
            <li key={c.id} className="flex justify-between gap-3 py-1.5">
              <span>
                {c.contact_name}
                <span className="text-muted-foreground print:text-black">
                  {" "}
                  · {c.assignee ? `with ${c.assignee}` : "nobody assigned"}
                </span>
              </span>
              <span className="text-muted-foreground print:text-black">
                since{" "}
                {c.last_message_at
                  ? formatInTimeZone(new Date(c.last_message_at), tz, "d MMM h:mm a")
                  : "?"}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Open call tasks" empty="No call is waiting." count={data.openCalls.length}>
        <ul className="divide-y text-sm">
          {data.openCalls.map((t) => (
            <li key={t.id} className="flex justify-between gap-3 py-1.5">
              <span>
                {t.contact_name ?? "No patient linked"} · {t.subject}
                <span className="text-muted-foreground print:text-black">
                  {" "}
                  · {t.assignee ? t.assignee : "unassigned"}
                </span>
              </span>
              <span className="text-muted-foreground print:text-black">
                due {formatInTimeZone(new Date(t.due_at), tz, "d MMM h:mm a")}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Messages that failed to send today"
        empty="Nothing failed today."
        count={data.failed.length}
      >
        <ul className="divide-y text-sm">
          {data.failed.map((m) => (
            <li key={m.id} className="flex justify-between gap-3 py-1.5">
              <span>
                {m.contact_name}
                <span className="text-muted-foreground print:text-black">
                  {" "}
                  · {m.error_code ? `error ${m.error_code}` : "not sent"}
                  {m.error ? ` · ${m.error}` : ""}
                </span>
              </span>
              <span className="text-muted-foreground print:text-black">{time(m.at)}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Handover notes" empty="No open notes." count={data.notes.length}>
        <ul className="flex flex-col gap-2 text-sm">
          {data.notes.map((n) => (
            <li key={n.id} className="rounded border p-2">
              <p className="whitespace-pre-wrap">{n.body}</p>
              <p className="text-muted-foreground mt-1 text-xs print:text-black">
                {n.author ?? "Someone"} ·{" "}
                {formatInTimeZone(new Date(n.created_at), tz, "d MMM h:mm a")}
              </p>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="break-inside-avoid">
      <h2 className="mb-2 border-b pb-1 text-base font-semibold">
        {title} <span className="text-muted-foreground print:text-black">({count})</span>
      </h2>
      {count === 0 ? (
        <p className="text-muted-foreground text-sm print:text-black">{empty}</p>
      ) : (
        children
      )}
    </section>
  );
}
