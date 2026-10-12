import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requirePerm } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { money } from "@/lib/finance/format";
import { PREAUTH_STATUSES, preauthExpiry, type PreauthStatus } from "@/lib/finance/preauth";
import { loadFinanceSettings } from "@/lib/finance/settings-db";
import { createClient } from "@/lib/supabase/server";

import {
  NewPreauthButton,
  PreauthDrawer,
  PreauthStatusBadge,
  type PreauthRow,
} from "./preauth-forms";

export const metadata = { title: "Pre-authorisations" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;
type Search = { q?: string; status?: string; expiring?: string; page?: string };
const safe = (v: string | undefined) =>
  (v ?? "")
    .replace(/[(),%*\\]/g, " ")
    .trim()
    .slice(0, 60);

export default async function PreauthPage({ searchParams }: { searchParams: Promise<Search> }) {
  const member = await requirePerm("finance.preauth.manage");
  const sp = await searchParams;
  const page = Math.max(1, Number(sp.page) || 1);
  const supabase = await createClient(); // the member's own client: RLS decides
  const settings = await loadFinanceSettings(supabase, member.orgId);
  const today = todayIn(member.org.timezone);

  const status = (PREAUTH_STATUSES as readonly string[]).includes(sp.status ?? "")
    ? (sp.status as PreauthStatus)
    : null;
  let query = supabase
    .from("fin_pre_authorisations")
    .select(
      "id, patient_pin, payer_id, auth_number, cpt_codes, status, requested_on, decision_on, valid_from, expires_on, approved_amount, approved_units, reference_note, appointment_id, claim_activity_id",
      { count: "exact" },
    )
    .order("expires_on", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (status) query = query.eq("status", status);
  else if (sp.status !== "all")
    query = query.in("status", ["draft", "requested", "approved", "partially_approved"]);
  const q = safe(sp.q);
  if (q)
    query = query.or(`patient_pin.ilike.%${q}%,auth_number.ilike.%${q}%,payer_id.ilike.%${q}%`);
  if (sp.expiring === "1")
    query = query
      .in("status", ["approved", "partially_approved"])
      .not("expires_on", "is", null)
      .lte(
        "expires_on",
        new Date(Date.parse(`${today}T00:00:00Z`) + settings.preauthExpiryLeadDays * 86_400_000)
          .toISOString()
          .slice(0, 10),
      );
  const { data, count } = await query;
  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // appointment numbers and claim numbers, where the member may see them (otherwise just "linked")
  const apptIds = [
    ...new Set((data ?? []).map((r) => r.appointment_id).filter((x): x is string => !!x)),
  ];
  const claimIds = [
    ...new Set((data ?? []).map((r) => r.claim_activity_id).filter((x): x is string => !!x)),
  ];
  const [appts, claims] = await Promise.all([
    apptIds.length
      ? supabase.from("appointments").select("id, number").in("id", apptIds)
      : Promise.resolve({ data: [] as Array<{ id: string; number: number }> }),
    claimIds.length
      ? supabase.from("ins_claim_activities").select("id, claim_activity_number").in("id", claimIds)
      : Promise.resolve({ data: [] as Array<{ id: string; claim_activity_number: string }> }),
  ]);
  const apptNo = new Map((appts.data ?? []).map((a) => [a.id, a.number]));
  const claimNo = new Map((claims.data ?? []).map((c) => [c.id, c.claim_activity_number]));

  const rows: PreauthRow[] = (data ?? []).map((r) => ({
    id: r.id,
    patient_pin: r.patient_pin,
    payer_id: r.payer_id,
    auth_number: r.auth_number,
    cpt_codes: r.cpt_codes ?? [],
    status: r.status as PreauthStatus,
    requested_on: r.requested_on,
    decision_on: r.decision_on,
    valid_from: r.valid_from,
    expires_on: r.expires_on,
    approved_amount: r.approved_amount === null ? null : Number(r.approved_amount),
    approved_units: r.approved_units,
    reference_note: r.reference_note,
    appointment_number: r.appointment_id ? (apptNo.get(r.appointment_id) ?? null) : null,
    claim_number: r.claim_activity_id ? (claimNo.get(r.claim_activity_id) ?? null) : null,
    hasAppointment: !!r.appointment_id,
    hasClaim: !!r.claim_activity_id,
  }));

  const link = (p: number) => {
    const params = new URLSearchParams(
      Object.entries({ ...sp, page: String(p) }).filter(([, v]) => v) as [string, string][],
    );
    return `/finance/preauth?${params.toString()}`;
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Pre-authorisations"
        description={`${total.toLocaleString()} shown. Track each request from the payer's answer to its expiry; a task is created ${settings.preauthExpiryLeadDays} days before an approval expires.`}
      >
        <NewPreauthButton />
      </PageHeader>
      <form className="grid gap-2 sm:grid-cols-6">
        <Input
          name="q"
          placeholder="PIN, authorisation number or payer"
          defaultValue={sp.q}
          className="sm:col-span-2"
        />
        <select
          name="status"
          defaultValue={sp.status ?? ""}
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
        >
          <option value="">In progress</option>
          <option value="all">Every status</option>
          {PREAUTH_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replaceAll("_", " ")}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="expiring" value="1" defaultChecked={sp.expiring === "1"} />{" "}
          Expiring soon
        </label>
        <Button type="submit" variant="secondary">
          Filter
        </Button>
      </form>
      <Card>
        <CardContent className="pt-6">
          {rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No pre-authorisations to show. Use “New pre-authorisation” when you send a request to
              a payer.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>PIN</TableHead>
                  <TableHead>Payer</TableHead>
                  <TableHead>Authorisation</TableHead>
                  <TableHead>Services</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="text-right">Approved</TableHead>
                  <TableHead>Linked to</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  const e = preauthExpiry(
                    r.status,
                    r.expires_on,
                    today,
                    settings.preauthExpiryLeadDays,
                  );
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-mono text-xs">{r.patient_pin ?? "—"}</TableCell>
                      <TableCell className="text-xs">{r.payer_id}</TableCell>
                      <TableCell className="font-mono text-xs">{r.auth_number ?? "—"}</TableCell>
                      <TableCell className="max-w-48 truncate text-xs">
                        {r.cpt_codes.join(", ") || "—"}
                      </TableCell>
                      <TableCell>
                        <PreauthStatusBadge status={r.status} />
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.expires_on ?? "—"}
                        {e.state === "expiring" && (
                          <Badge variant="warning" className="ml-2">
                            {e.daysLeft === 0 ? "today" : `${e.daysLeft} d`}
                          </Badge>
                        )}
                        {e.state === "expired" && (
                          <Badge variant="destructive" className="ml-2">
                            expired
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {r.approved_amount === null ? "—" : money(r.approved_amount)}
                      </TableCell>
                      <TableCell className="text-xs">
                        {r.hasAppointment ? `Appt ${r.appointment_number ?? ""}`.trim() : ""}
                        {r.hasAppointment && r.hasClaim ? ", " : ""}
                        {r.hasClaim ? (
                          r.claim_number ? (
                            <span className="font-mono">{r.claim_number}</span>
                          ) : (
                            "claim"
                          )
                        ) : (
                          ""
                        )}
                        {!r.hasAppointment && !r.hasClaim && "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <PreauthDrawer row={r} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          Page {page} of {pages}
        </span>
        <div className="flex gap-2">
          {page > 1 && (
            <Button asChild variant="outline" size="sm">
              <Link href={link(page - 1)}>Previous</Link>
            </Button>
          )}
          {page < pages && (
            <Button asChild variant="outline" size="sm">
              <Link href={link(page + 1)}>Next</Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
