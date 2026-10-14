import "server-only";

import { paymentLines, slipFirstName, type PaymentLine } from "@/lib/front-desk/slip";
import type { AdminClient } from "@/lib/supabase/admin";

export type SlipData = {
  id: string;
  number: number;
  starts_at: string;
  ends_at: string;
  status: string;
  source: string;
  external_id: string | null;
  location_id: string | null;
  timezone: string;
  first_name: string;
  doctor: string | null;
  branch: { name: string; address: string | null } | null;
};

/** What the slip prints: no service, notes, phone or anything clinical is read. */
export async function loadSlip(
  admin: AdminClient,
  orgId: string,
  appointmentId: string,
  orgTimezone: string,
): Promise<SlipData | null> {
  const { data } = await admin
    .from("appointments")
    .select(
      "id, number, starts_at, ends_at, status, source, external_id, location_id, contacts(first_name, full_name), specialists(name), locations(name, address, timezone)",
    )
    .eq("id", appointmentId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!data) return null;
  const a = data as unknown as {
    id: string;
    number: number;
    starts_at: string;
    ends_at: string;
    status: string;
    source: string;
    external_id: string | null;
    location_id: string | null;
    contacts: { first_name: string | null; full_name: string | null } | null;
    specialists: { name: string } | null;
    locations: { name: string; address: string | null; timezone: string } | null;
  };
  return {
    id: a.id,
    number: a.number,
    starts_at: a.starts_at,
    ends_at: a.ends_at,
    status: a.status,
    source: a.source,
    external_id: a.external_id,
    location_id: a.location_id,
    timezone: a.locations?.timezone || orgTimezone,
    first_name: slipFirstName(a.contacts?.first_name, a.contacts?.full_name),
    doctor: a.specialists?.name ?? null,
    branch: a.locations ? { name: a.locations.name, address: a.locations.address } : null,
  };
}

/**
 * The payments Pulse holds for a visit: the Unite finance mirror's payments on invoices for this Unite appointment, and
 * paid online payment links on those invoices. The caller checks finance.invoices.view first. Amounts, dates, modes and
 * receipt numbers only.
 */
export async function loadPaymentRecord(
  admin: AdminClient,
  orgId: string,
  slip: Pick<SlipData, "source" | "external_id">,
): Promise<{ invoices: number; lines: PaymentLine[]; total: number } | null> {
  if (slip.source !== "unite" || !slip.external_id) return { invoices: 0, lines: [], total: 0 };
  const { data: invoices, error } = await admin
    .from("fin_invoices")
    .select("id")
    .eq("org_id", orgId)
    .eq("appointment_id", slip.external_id)
    .eq("is_deleted", false)
    .limit(20);
  if (error) return null;
  const ids = (invoices ?? []).map((i) => i.id);
  if (ids.length === 0) return { invoices: 0, lines: [], total: 0 };
  const [mirror, online] = await Promise.all([
    admin
      .from("fin_payments")
      .select("paid, refund, paid_date, payment_mode, receipt_number, is_current")
      .eq("org_id", orgId)
      .in("invoice_id", ids)
      .eq("is_current", true)
      .limit(200),
    admin
      .from("fin_payment_requests")
      .select("status, amount_paid_minor, amount_minor, paid_at, invoice_number")
      .eq("org_id", orgId)
      .in("invoice_id", ids)
      .eq("status", "paid")
      .limit(50),
  ]);
  if (mirror.error || online.error) return null;
  return { invoices: ids.length, ...paymentLines(mirror.data ?? [], online.data ?? []) };
}
