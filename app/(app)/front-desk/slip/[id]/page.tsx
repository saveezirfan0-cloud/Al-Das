import Link from "next/link";
import { notFound } from "next/navigation";
import { formatInTimeZone } from "date-fns-tz";

import { PageHeader } from "@/components/shell/page-header";
import { PrintButton } from "@/components/shell/print-button";
import { Button } from "@/components/ui/button";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { branchAllowed } from "@/lib/branches/guard";
import { money } from "@/lib/finance/format";
import { bookingNumber, RECEIPT_NOTICE, slipKind } from "@/lib/front-desk/slip";
import { loadPaymentRecord, loadSlip } from "@/lib/front-desk/slip-server";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";
import { cn } from "@/lib/utils";

export const metadata = { title: "Appointment slip" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Printable appointment slip (and, for finance readers, the visit's payment record). The app shell is hidden on paper
 * (print:hidden in the app layout); this page hides its own toolbar the same way. Minimal by design: first name, time,
 * doctor, branch and address, booking number. Nothing clinical.
 */
export default async function SlipPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const member = await requirePerm("frontdesk.use");
  if (!can(member, "appointments.view")) notFound();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const sp = await searchParams;
  const kind = slipKind(sp.kind);
  const canReceipt = can(member, "finance.invoices.view");

  const admin = createAdminClient();
  const slip = await loadSlip(admin, member.orgId, id, member.org.timezone || "Asia/Dubai");
  // Phase B: an appointment in a branch the member does not work in is "not found", like elsewhere.
  if (!slip || !branchAllowed(member, slip.location_id)) notFound();

  const record =
    kind === "receipt" && canReceipt ? await loadPaymentRecord(admin, member.orgId, slip) : null;
  await recordAccess(admin, member, {
    entity: "appointment",
    entityId: slip.id,
    action: "view",
    detail: { screen: kind === "receipt" ? "payment_record" : "slip" },
  });

  const tz = slip.timezone;
  const day = formatInTimeZone(new Date(slip.starts_at), tz, "EEEE d MMMM yyyy");
  const time = formatInTimeZone(new Date(slip.starts_at), tz, "h:mm a");
  const cancelled = slip.status === "cancelled" || slip.status === "no_show";

  return (
    <div className="flex flex-col gap-6">
      <div className="print:hidden">
        <PageHeader
          title={kind === "receipt" ? "Payment record" : "Appointment slip"}
          description="Print it for the patient. It carries the first name, time, doctor, branch and booking number only."
        >
          <PrintButton label={kind === "receipt" ? "Print the record" : "Print the slip"} />
          <Button size="sm" variant="outline" asChild>
            <Link href="/front-desk">Back to the desk</Link>
          </Button>
        </PageHeader>
        <nav className="mt-3 flex gap-2" aria-label="What to print">
          <Button size="sm" variant={kind === "slip" ? "default" : "outline"} asChild>
            <Link
              href={`/front-desk/slip/${slip.id}`}
              aria-current={kind === "slip" ? "page" : undefined}
            >
              Slip
            </Link>
          </Button>
          {canReceipt && (
            <Button size="sm" variant={kind === "receipt" ? "default" : "outline"} asChild>
              <Link
                href={`/front-desk/slip/${slip.id}?kind=receipt`}
                aria-current={kind === "receipt" ? "page" : undefined}
              >
                Payment record
              </Link>
            </Button>
          )}
        </nav>
      </div>

      <article
        aria-label={kind === "receipt" ? "Payment record" : "Appointment slip"}
        className="mx-auto w-full max-w-sm rounded-xl border bg-white p-6 text-zinc-900 shadow-sm print:max-w-none print:border-0 print:p-0 print:shadow-none"
      >
        <header className="mb-4 border-b border-zinc-300 pb-3">
          <p className="text-lg font-semibold">{member.org.name}</p>
          {slip.branch && (
            <p className="text-sm">
              {slip.branch.name}
              {slip.branch.address && (
                <span className="block text-zinc-600">{slip.branch.address}</span>
              )}
            </p>
          )}
        </header>

        {kind === "slip" ? (
          <dl className="grid grid-cols-[6.5rem_1fr] gap-y-2 text-sm">
            <dt className="text-zinc-600">For</dt>
            <dd className="font-medium">{slip.first_name}</dd>
            <dt className="text-zinc-600">Day</dt>
            <dd className={cn("font-medium", cancelled && "line-through")}>{day}</dd>
            <dt className="text-zinc-600">Time</dt>
            <dd className={cn("text-xl font-semibold tabular-nums", cancelled && "line-through")}>
              {time}
            </dd>
            <dt className="text-zinc-600">Doctor</dt>
            <dd>{slip.doctor ?? "To be confirmed"}</dd>
            <dt className="text-zinc-600">Booking</dt>
            <dd className="tabular-nums">{bookingNumber(slip.number)}</dd>
            {cancelled && (
              <dd className="col-span-2 mt-2 rounded border border-zinc-400 p-2 text-center font-medium">
                This appointment is {slip.status === "no_show" ? "closed" : "cancelled"}.
              </dd>
            )}
          </dl>
        ) : (
          <section className="flex flex-col gap-3 text-sm">
            <p>
              {slip.first_name} · {day} · {bookingNumber(slip.number)}
            </p>
            {!canReceipt || record === null ? (
              <p className="rounded border border-zinc-300 p-3 text-zinc-700">
                The payment record could not be read. Check Finance, Invoices.
              </p>
            ) : record.lines.length === 0 ? (
              <p className="rounded border border-zinc-300 p-3 text-zinc-700">
                No payment is recorded in Pulse for this visit.
              </p>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-zinc-300 text-left text-xs text-zinc-600">
                    <th className="py-1 pr-2 font-medium">Date</th>
                    <th className="py-1 pr-2 font-medium">How</th>
                    <th className="py-1 pr-2 font-medium">Reference</th>
                    <th className="py-1 text-right font-medium">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {record.lines.map((l, i) => (
                    <tr key={i} className="border-b border-zinc-200">
                      <td className="py-1 pr-2 tabular-nums">{l.date ?? ""}</td>
                      <td className="py-1 pr-2">{l.mode}</td>
                      <td className="py-1 pr-2">{l.reference ?? ""}</td>
                      <td className="py-1 text-right tabular-nums">{money(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3} className="pt-2 font-medium">
                      Total recorded
                    </td>
                    <td className="pt-2 text-right font-semibold tabular-nums">
                      {money(record.total)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            )}
            <p className="text-xs text-zinc-600">{RECEIPT_NOTICE}</p>
          </section>
        )}
        <footer className="mt-5 border-t border-zinc-300 pt-3 text-xs text-zinc-600">
          Please arrive ten minutes early and bring your insurance card.
        </footer>
      </article>
    </div>
  );
}
