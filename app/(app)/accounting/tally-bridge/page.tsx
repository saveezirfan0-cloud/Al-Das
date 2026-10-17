import Link from "next/link";

import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { accountingErrorMessage } from "@/lib/accounting/errors";
import { DEFAULT_PUSH_SOURCES, voucherNumberFor } from "@/lib/accounting/tally/bridge";
import { resolveCompanies } from "@/lib/accounting/tally/companies";
import { can, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { loadView } from "@/lib/integrations/accounts";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  BridgeSettingsForm,
  PairingPanel,
  RetryButton,
  RevokeButton,
  type BridgeSettingsView,
} from "./forms";

/** The push statuses the summary line counts. */
const PUSH_STATUSES = ["done", "ready", "sent", "held", "failed", "unknown"] as const;

export const metadata = { title: "Tally bridge" };
export const dynamic = "force-dynamic";

const PUSH_STATUS: Record<
  string,
  { label: string; variant: "outline" | "warning" | "success" | "secondary" | "destructive" }
> = {
  held: { label: "Waiting", variant: "warning" },
  ready: { label: "Queued", variant: "outline" },
  sent: { label: "Sent, no answer yet", variant: "outline" },
  done: { label: "In Tally", variant: "success" },
  failed: { label: "Refused by Tally", variant: "destructive" },
  unknown: { label: "Answer never came", variant: "destructive" },
  cancelled: { label: "Withdrawn", variant: "secondary" },
};

const KIND_LABEL: Record<string, string> = {
  unite_invoice_day: "Unite revenue (day)",
  unite_payment_day: "Unite payments (day)",
  unite_invoice: "Unite invoice",
  unite_payment: "Unite payment",
  supplier_invoice: "Supplier invoice",
  voucher: "Payment voucher",
  sales_invoice: "Sales document",
  receipt: "Receipt",
  bank_transfer: "Bank transfer",
  bank_entry: "Bank entry",
  petty_cash: "Petty cash",
  cheque: "Cheque",
  fixed_asset: "Depreciation / schedules",
  remittance: "Remittance",
  denial: "Denial",
  revshare_run: "Revenue share",
  lab_charge: "Lab statement",
  cashup: "Cash-up",
  settlement: "Settlement",
};

const JOB_LABEL: Record<string, string> = {
  export_masters_since: "Masters from Tally",
  export_vouchers_since: "Vouchers from Tally",
  export_trial_balance: "Trial balance check",
  import_voucher: "Voucher to Tally",
};

const when = (iso: string | null | undefined) =>
  iso ? iso.slice(0, 16).replace("T", " ") : "never";
const money = (n: number | string | null) =>
  Number(n ?? 0).toLocaleString("en-AE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default async function TallyBridgePage() {
  const member = await requireMember();
  if (!can(member, "accounting.import")) throw new ForbiddenError("accounting.import");
  const canEdit = can(member, "accounting.settings.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const org = member.orgId;
  const [
    view,
    settingsRow,
    devices,
    entity,
    statusRows,
    attention,
    recent,
    jobs,
    log,
    cursors,
    tb,
    unite,
  ] = await Promise.all([
    loadView(admin, org, "tally_bridge"),
    admin
      .from("acc_tally_bridge_settings")
      .select("push_enabled, pull_enabled, push_from, revenue_mode, push_sources, cost_category")
      .eq("org_id", org)
      .maybeSingle(),
    admin
      .from("acc_tally_devices")
      .select(
        "id, label, status, version, tally_state, last_seen_at, paired_at, created_at, pairing_expires_at",
      )
      .eq("org_id", org)
      .in("status", ["pairing", "active"])
      .order("created_at", { ascending: false })
      .limit(5),
    admin
      .from("acc_entities")
      .select("id, name, is_default, active, ledger_start_date, tally_company")
      .eq("org_id", org)
      .order("is_default", { ascending: false })
      .order("name"),
    // One exact count per status (PostgREST returns at most 1,000 rows, so counting fetched rows reads low).
    Promise.all(
      PUSH_STATUSES.map(async (status) => {
        const { count } = await admin
          .from("acc_tally_push")
          .select("id", { count: "exact", head: true })
          .eq("org_id", org)
          .eq("status", status);
        return [status, count ?? 0] as const;
      }),
    ),
    admin
      .from("acc_tally_push")
      .select(
        "id, source_kind, source_id, role, remote_id, voucher_date, amount, status, reason, detail, updated_at",
      )
      .eq("org_id", org)
      .in("status", ["held", "failed", "unknown", "sent"])
      .order("voucher_date", { ascending: false })
      .limit(100),
    admin
      .from("acc_tally_push")
      .select(
        "id, source_kind, source_id, role, remote_id, voucher_date, amount, status, mirror_journal_id, done_at",
      )
      .eq("org_id", org)
      .eq("status", "done")
      .order("done_at", { ascending: false })
      .limit(15),
    admin
      .from("acc_tally_jobs")
      .select("kind, status, error_code, created_at, done_at, result")
      .eq("org_id", org)
      .neq("kind", "import_voucher")
      .order("seq", { ascending: false })
      .limit(12),
    admin
      .from("acc_tally_sync_log")
      .select(
        "id, at, direction, outcome, code, message, remote_id, tally_guid, voucher_date, voucher_number",
      )
      .eq("org_id", org)
      .order("at", { ascending: false })
      .limit(30),
    admin
      .from("acc_tally_cursors")
      .select("entity_id, cursor, alter_id, updated_at")
      .eq("org_id", org),
    admin
      .from("acc_tally_reconciliations")
      .select("as_at, compared, differences, total_difference, reconciled, rows, created_at")
      .eq("org_id", org)
      .eq("source", "bridge")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from("acc_tally_push")
      .select("id", { count: "exact", head: true })
      .eq("org_id", org)
      .in("source_kind", [
        "unite_invoice",
        "unite_payment",
        "unite_invoice_day",
        "unite_payment_day",
      ])
      .neq("status", "cancelled"),
  ]);

  const settings: BridgeSettingsView = (settingsRow.data as BridgeSettingsView | null) ?? {
    push_enabled: false,
    pull_enabled: false,
    push_from: null,
    revenue_mode: "daily",
    push_sources: [...DEFAULT_PUSH_SOURCES],
    cost_category: "Primary Cost Category",
  };
  const counts = new Map<string, number>(statusRows);
  const company = String(view.config.company ?? "");
  // one Tally company per entity (W7); the default entity falls back to the integration's company
  const entities = (entity.data ?? []).filter((e) => e.active);
  const companyOf = resolveCompanies(entity.data ?? [], company || null);
  const cursorOf = (entityId: string, name: "masters" | "vouchers") =>
    (cursors.data ?? []).find((c) => c.entity_id === entityId && c.cursor === name);
  const active = (devices.data ?? []).find((d) => d.status === "active");
  const tbRows =
    (tb.data?.rows as Array<{
      name: string;
      tally_name: string | null;
      pulse: number;
      tally: number;
      difference: number;
    }> | null) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Tally bridge"
        description="Keeps TallyPrime in step with Pulse until the ledger start. Pulse's approved items go to Tally as vouchers (each sent once, identified by a Pulse id), and what is entered in Tally comes back into Pulse's ledger. A connector on the Tally PC does the talking; Tally is never exposed to the internet."
      />

      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          <div>
            Integration:{" "}
            {view.enabled ? (
              <Badge variant="success">On</Badge>
            ) : (
              <Badge variant="secondary">Off</Badge>
            )}{" "}
            {company
              ? `Default Tally company "${company}" (used by the default entity unless it has its own). `
              : "No default Tally company name yet. "}
            {can(member, "integrations.manage") && (
              <Link href="/settings/integrations/tally_bridge" className="underline">
                Settings, Integrations
              </Link>
            )}
          </div>
          <div>
            Connector:{" "}
            {active ? (
              <>
                <Badge variant={active.tally_state === "ok" ? "success" : "warning"}>
                  {active.tally_state === "ok"
                    ? "Tally answering"
                    : active.tally_state === "unreachable"
                      ? "Tally not running or port closed"
                      : active.tally_state === "no_company"
                        ? "Company not open in Tally"
                        : "Unknown"}
                </Badge>{" "}
                {active.label}, version {active.version ?? "?"}, last seen{" "}
                {when(active.last_seen_at)} UTC.
              </>
            ) : (
              "not paired."
            )}
          </div>
          <div className="text-muted-foreground">
            Vouchers: {counts.get("done") ?? 0} in Tally, {counts.get("ready") ?? 0} queued,{" "}
            {counts.get("sent") ?? 0} sent, {counts.get("held") ?? 0} waiting,{" "}
            {counts.get("failed") ?? 0} refused, {counts.get("unknown") ?? 0} without an answer.
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tally companies</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 overflow-x-auto text-sm">
          <p className="text-muted-foreground">
            One Tally company per entity, set under Accounting, Setup, Entities and fiscal years. An
            entity without one is not bridged: nothing is sent for it and nothing is pulled. Pushing
            stops for each entity on its own ledger start.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Entity</TableHead>
                <TableHead>Tally company</TableHead>
                <TableHead>Ledger start</TableHead>
                <TableHead>Masters pulled to</TableHead>
                <TableHead>Vouchers pulled to</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entities.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>{e.name}</TableCell>
                  <TableCell>
                    {companyOf.get(e.id) ?? (
                      <span className="text-muted-foreground">none: not bridged</span>
                    )}
                  </TableCell>
                  <TableCell>{e.ledger_start_date ?? "not set"}</TableCell>
                  {(["masters", "vouchers"] as const).map((name) => (
                    <TableCell key={name}>
                      AlterID {cursorOf(e.id, name)?.alter_id ?? "-"} (
                      {when(cursorOf(e.id, name)?.updated_at)})
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connector</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">
            Install the connector on the PC where TallyPrime runs (steps in the help guide and
            docs/22_PHASE_22J_NOTES.md), then create a pairing code here and type it there. The
            connector keeps only its own token; revoke it here whenever the PC changes hands.
          </p>
          {(devices.data ?? []).length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>PC</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Paired</TableHead>
                  <TableHead>Last seen</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(devices.data ?? []).map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>{d.label}</TableCell>
                    <TableCell>
                      {d.status === "pairing"
                        ? `Waiting for the code (until ${when(d.pairing_expires_at)})`
                        : "Paired"}
                    </TableCell>
                    <TableCell>{when(d.paired_at)}</TableCell>
                    <TableCell>{when(d.last_seen_at)}</TableCell>
                    <TableCell className="text-right">
                      {canEdit && <RevokeButton id={d.id} />}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <PairingPanel canEdit={canEdit} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Settings</CardTitle>
        </CardHeader>
        <CardContent>
          <BridgeSettingsForm
            value={settings}
            canEdit={canEdit}
            modeLocked={(unite.count ?? 0) > 0}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Waiting, refused or without an answer</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Tally number</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Why</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(attention.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={7}>
                    <EmptyState title="Nothing waiting" className="border-0 p-6" />
                  </TableCell>
                </TableRow>
              )}
              {(attention.data ?? []).map((p) => {
                const s = PUSH_STATUS[p.status] ?? PUSH_STATUS.held;
                return (
                  <TableRow key={p.id}>
                    <TableCell>{p.voucher_date}</TableCell>
                    <TableCell className="text-xs">
                      {KIND_LABEL[p.source_kind] ?? p.source_kind}
                      {p.role === "reversal" ? " (reversal)" : ""}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {voucherNumberFor(p.remote_id)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{money(p.amount)}</TableCell>
                    <TableCell>
                      <Badge variant={s.variant}>{s.label}</Badge>
                    </TableCell>
                    <TableCell className="max-w-md text-xs">
                      {p.reason ? accountingErrorMessage(p.reason, p.reason) : ""}
                      {p.detail ? (
                        <span className="text-muted-foreground block">{p.detail}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">
                      {canEdit && (p.status === "failed" || p.status === "unknown") && (
                        <RetryButton id={p.id} />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Trial balance check</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {tb.data ? (
            <>
              <div>
                {tb.data.reconciled ? (
                  <Badge variant="success">No drift</Badge>
                ) : (
                  <Badge variant="destructive">{tb.data.differences} ledgers differ</Badge>
                )}{" "}
                Tally&apos;s closing balances at {tb.data.as_at} against Pulse&apos;s mirror (
                {tb.data.compared} ledgers compared, total difference{" "}
                {money(tb.data.total_difference)}).
              </div>
              {tbRows.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Ledger</TableHead>
                      <TableHead className="text-right">Pulse</TableHead>
                      <TableHead className="text-right">Tally</TableHead>
                      <TableHead className="text-right">Difference</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tbRows.slice(0, 50).map((r, i) => (
                      <TableRow key={i}>
                        <TableCell>{r.tally_name ?? r.name}</TableCell>
                        <TableCell className="text-right tabular-nums">{money(r.pulse)}</TableCell>
                        <TableCell className="text-right tabular-nums">{money(r.tally)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {money(r.difference)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              <p className="text-muted-foreground text-xs">
                Balances are debit minus credit. A voucher sent to Tally shows here once the next
                pull brings it back. A voucher deleted in Tally is not seen by the pull (Tally does
                not report deletions): it shows as drift.
              </p>
            </>
          ) : (
            <p className="text-muted-foreground">
              No check yet: it runs once a day while pulling is on.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recently in Tally</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Tally number</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>In Pulse&apos;s mirror</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(recent.data ?? []).map((p) => (
                <TableRow key={p.id}>
                  <TableCell>{p.voucher_date}</TableCell>
                  <TableCell className="text-xs">
                    {KIND_LABEL[p.source_kind] ?? p.source_kind}
                    {p.role === "reversal" ? " (reversal)" : ""}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {voucherNumberFor(p.remote_id)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(p.amount)}</TableCell>
                  <TableCell>
                    {p.mirror_journal_id ? (
                      <Link
                        href={`/accounting/journals/${p.mirror_journal_id}`}
                        className="underline"
                      >
                        Journal
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">after the next pull</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pulls and activity</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 text-sm lg:grid-cols-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>When</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(jobs.data ?? []).map((j, i) => (
                <TableRow key={i}>
                  <TableCell>{JOB_LABEL[j.kind] ?? j.kind}</TableCell>
                  <TableCell className="text-xs">
                    {j.status}
                    {j.error_code ? ` (${accountingErrorMessage(j.error_code, j.error_code)})` : ""}
                  </TableCell>
                  <TableCell className="text-xs">{when(j.done_at ?? j.created_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>What</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(log.data ?? []).map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="text-xs">{when(l.at)}</TableCell>
                  <TableCell className="text-xs">
                    {l.direction} {l.outcome}
                    {l.code ? ` (${l.code})` : ""}
                  </TableCell>
                  <TableCell className="max-w-xs text-xs">
                    {l.remote_id ? voucherNumberFor(l.remote_id) : (l.voucher_number ?? "")}
                    {l.voucher_date ? ` ${l.voucher_date}` : ""}
                    {l.message ? (
                      <span className="text-muted-foreground block">{l.message}</span>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
