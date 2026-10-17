import Link from "next/link";
import { Landmark } from "lucide-react";

import { KpiTile } from "@/components/charts/kpi-tile";
import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Term } from "@/components/shell/term";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { AGE_BUCKETS } from "@/lib/finance/bank-recon";
import { money } from "@/lib/finance/format";
import { loadMatching, optionFingerprint } from "@/lib/finance/match-v2-server";
import { RULE_LABELS } from "@/lib/finance/match-v2-types";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

import { CreditsTable, OpenItemsTable, type CreditRow, type ItemRow } from "./item-tables";
import { ReceiptRegisterImport } from "./receipt-import";
import {
  AliasPanel,
  ProposalList,
  RulesPanel,
  RunMatchingButton,
  type ProposalRow,
  type RuleRow,
} from "./review-panels";

export const metadata = { title: "Insurer payments" };
export const dynamic = "force-dynamic";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "items", label: "Open payments" },
  { id: "credits", label: "Bank deposits" },
  { id: "proposals", label: "Proposals" },
  { id: "rules", label: "Rules and names" },
] as const;
type TabId = (typeof TABS)[number]["id"];
const SHOWS = ["open", "paid", "closed", "all"] as const;
type Show = (typeof SHOWS)[number];
const ITEM_CAP = 300;
const PROPOSAL_CAP = 100;

type Search = { tab?: string; show?: string };

const AGE_WORDS: Record<string, string> = {
  waiting: "Not due yet",
  "0-7": "Up to 7 days",
  "8-30": "8 to 30 days",
  "31-60": "31 to 60 days",
  "60+": "Over 60 days",
};

export default async function InsurerPaymentsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const member = await requirePerm("finance.matching.view");
  const sp = await searchParams;
  const tab: TabId = TABS.some((t) => t.id === sp.tab) ? (sp.tab as TabId) : "overview";
  const show: Show = SHOWS.includes(sp.show as Show) ? (sp.show as Show) : "open";
  const canManage = can(member, "finance.matching.manage");
  const canApprove = can(member, "finance.matching.approve");

  const admin = createAdminClient(); // service role AFTER the permission check
  const view = await loadMatching(admin, member.orgId, todayIn(member.org.timezone));
  const supabase = await createClient(); // the member's own client (RLS) for the layouts they may use
  const { data: formats } = canManage
    ? await supabase
        .from("fin_import_formats")
        .select("id, name")
        .eq("kind", "receipt_register")
        .eq("active", true)
        .order("name")
    : { data: [] };

  // ---- rows for the client tables -------------------------------------------------
  const closureByItem = new Map(view.closures.map((c) => [c.itemRef, c]));
  const filtered = view.items.filter((i) =>
    show === "all" ? true : show === "open" ? i.status === "open" || i.status === "part" : i.status === show,
  );
  const shownItems = filtered.slice(0, ITEM_CAP);
  const allocsByItem = new Map<string, ItemRow["allocations"]>();
  for (const a of view.allocations) {
    const list = allocsByItem.get(a.itemRef) ?? [];
    list.push({ id: a.id, lineDate: a.lineDate, amount: a.amount, rule: a.rule, auto: a.auto });
    allocsByItem.set(a.itemRef, list);
  }
  const itemRows: ItemRow[] = shownItems.map((i) => {
    const closure = closureByItem.get(i.ref);
    return {
      ref: i.ref,
      label: i.label,
      payer: i.payerKey,
      date: i.date,
      total: i.total,
      allocated: i.allocated,
      open: i.open,
      status: i.status,
      age: view.ageOf[i.ref] ?? null,
      source: i.source,
      mismatch: i.mismatch,
      matchedByMonthlyRun: i.matchedByMonthlyRun,
      allocations: allocsByItem.get(i.ref) ?? [],
      closure: closure ? { id: closure.id, kind: closure.kind, reasonCode: closure.reasonCode } : null,
    };
  });
  const creditRows: CreditRow[] = view.lines.map((l) => ({
    id: l.id,
    date: l.valueDate,
    amount: l.amount,
    open: l.open,
    text: l.text,
  }));
  const openItemRows: ItemRow[] = view.openItems.slice(0, ITEM_CAP).map((i) => ({
    ref: i.ref,
    label: i.label,
    payer: i.payerKey,
    date: i.date,
    total: i.total,
    allocated: i.allocated,
    open: i.open,
    status: i.status,
    age: null,
    source: i.source,
    mismatch: false,
    matchedByMonthlyRun: i.matchedByMonthlyRun,
    allocations: [],
    closure: null,
  }));

  const labelOf = new Map(view.items.map((i) => [i.ref, i.label]));
  const lineById = new Map(view.lines.map((l) => [l.id, l]));
  const proposalRows: ProposalRow[] = [...view.suggestions]
    .sort((a, b) => Number(b.auto) - Number(a.auto) || (lineById.get(a.lineId)?.valueDate ?? "").localeCompare(lineById.get(b.lineId)?.valueDate ?? ""))
    .slice(0, PROPOSAL_CAP)
    .map((s) => {
      const line = lineById.get(s.lineId);
      return {
        lineId: s.lineId,
        lineDate: line?.valueDate ?? "",
        lineOpen: line?.open ?? 0,
        lineText: line?.text ?? "",
        rule: s.rule,
        ruleLabel: RULE_LABELS[s.rule],
        auto: s.auto,
        options: s.options.map((o, index) => ({
          index,
          fingerprint: optionFingerprint(o),
          score: o.score,
          reasons: o.reasons,
          lineLeft: o.lineLeft,
          itemsLeft: o.itemsLeft,
          allocations: o.allocations.map((a) => ({
            itemRef: a.itemRef,
            label: labelOf.get(a.itemRef) ?? a.itemRef.slice(4),
            amount: a.amount,
          })),
        })),
      };
    });
  const ruleRows: RuleRow[] = view.gates.map((g) => ({
    rule: g.rule,
    label: RULE_LABELS[g.rule],
    on: g.on,
    ok: g.ok,
    reason: g.reason,
    months: g.months,
  }));
  const payers = [
    ...new Set([
      ...view.items.map((i) => i.payerKey).filter((p): p is string => !!p),
      ...view.aliases.map((a) => a.payerKey),
    ]),
  ].sort();

  const hasAnyItem = view.items.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Insurer payments"
        description={
          <>
            Every payment an insurer sends stays on this list as an <Term k="open-item" /> until the bank deposits that paid
            it are matched in full, or it is written off or cancelled with a reason. A deposit can pay several payments,
            and a payment can be paid in parts: each part is an <Term k="allocation" />.
          </>
        }
      />

      <nav aria-label="Insurer payments sections" className="flex flex-wrap gap-1 border-b">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={t.id === "overview" ? "/finance/matching" : `/finance/matching?tab=${t.id}`}
            aria-current={tab === t.id ? "page" : undefined}
            className={cn(
              "-mb-px rounded-t-md border-b-2 px-3 py-2 text-sm",
              tab === t.id
                ? "border-primary text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground border-transparent",
            )}
          >
            {t.label}
            {t.id === "proposals" && view.totals.suggestions > 0 && (
              <span className="bg-muted ml-1.5 rounded-full px-1.5 text-xs tabular-nums">{view.totals.suggestions}</span>
            )}
          </Link>
        ))}
      </nav>

      {!view.account && (
        <EmptyState
          icon={Landmark}
          title="No bank account is marked as receiving insurers' payments"
          description="Matching needs the bank statement of the account insurers pay into. Mark that account under Bank reconciliation, Accounts and rules, then import its statement."
          action={
            <Link className="text-sm underline" href="/finance/bank/settings">
              Open bank accounts
            </Link>
          }
        />
      )}

      {tab === "overview" && (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiTile
              label="Insurer payments still open"
              value={view.totals.openItems}
              hint={`AED ${money(view.totals.openAmount)} still to receive`}
              href="/finance/matching?tab=items"
            />
            <KpiTile
              label="Bank deposits not yet explained"
              value={view.totals.unexplainedCredits}
              hint={`AED ${money(view.totals.unexplainedAmount)}`}
              href="/finance/matching?tab=credits"
            />
            <KpiTile
              label="Proposals waiting for a person"
              value={view.totals.suggestions - view.totals.autoReady}
              href="/finance/matching?tab=proposals"
            />
            <KpiTile
              label="Ready to match automatically"
              value={view.totals.autoReady}
              hint={view.totals.autoReady > 0 ? "Press Run matching" : "Needs a rule switched on"}
              href="/finance/matching?tab=rules"
            />
          </div>

          {canManage && (
            <div className="flex flex-wrap items-center gap-3">
              <RunMatchingButton />
              <p className="text-muted-foreground max-w-xl text-sm">
                Applies what the switched-on rules are sure of. Everything else is left as a proposal for you to accept or
                reject.
              </p>
            </div>
          )}

          <section aria-labelledby="age-heading">
            <h3 id="age-heading" className="mb-2 font-medium">
              How long open payments have waited
            </h3>
            {view.totals.openItems === 0 ? (
              <p className="text-muted-foreground text-sm">Nothing is open.</p>
            ) : (
              <Table className="max-w-xl">
                <TableHeader>
                  <TableRow>
                    <TableHead>Age</TableHead>
                    <TableHead className="text-right">Payments</TableHead>
                    <TableHead className="text-right">Still to receive</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {AGE_BUCKETS.map((b) => (
                    <TableRow key={b}>
                      <TableCell>{AGE_WORDS[b]}</TableCell>
                      <TableCell className="text-right tabular-nums">{view.ageBuckets[b].count}</TableCell>
                      <TableCell className="text-right tabular-nums">{money(view.ageBuckets[b].amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>

          {!hasAnyItem && (
            <EmptyState
              title="No insurer payments yet"
              description={
                canManage
                  ? "Import the receipt register below (one row per insurer payment), or upload a remittance advice under Remittance."
                  : "They appear when someone imports the receipt register or uploads a remittance advice."
              }
            />
          )}

          {canManage && (
            <section aria-labelledby="import-heading" className="max-w-3xl">
              <h3 id="import-heading" className="mb-2 font-medium">
                Import the receipt register
              </h3>
              <ReceiptRegisterImport formats={formats ?? []} />
            </section>
          )}
        </div>
      )}

      {tab === "items" && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2 text-sm" role="group" aria-label="Which payments to show">
            {SHOWS.map((s) => (
              <Link
                key={s}
                href={`/finance/matching?tab=items&show=${s}`}
                aria-current={show === s ? "true" : undefined}
                className={cn(
                  "rounded-full border px-3 py-1",
                  show === s ? "bg-primary text-primary-foreground border-transparent" : "hover:bg-muted",
                )}
              >
                {s === "open" ? "Still open" : s === "paid" ? "Paid in full" : s === "closed" ? "Closed" : "All"}
              </Link>
            ))}
          </div>
          <OpenItemsTable
            items={itemRows}
            credits={creditRows}
            canManage={canManage}
            canApprove={canApprove}
            total={filtered.length}
          />
        </div>
      )}

      {tab === "credits" && (
        <CreditsTable
          credits={creditRows}
          openItems={openItemRows}
          canManage={canManage}
          hasAccount={view.account !== null}
        />
      )}

      {tab === "proposals" && (
        <div className="flex flex-col gap-3">
          <ProposalList rows={proposalRows} canManage={canManage} />
          {view.suggestions.length > PROPOSAL_CAP && (
            <p className="text-muted-foreground text-xs">
              Showing the first {PROPOSAL_CAP} of {view.suggestions.length}. Deal with these and reload.
            </p>
          )}
        </div>
      )}

      {tab === "rules" && (
        <div className="flex flex-col gap-8">
          <RulesPanel
            rules={ruleRows}
            canApprove={canApprove}
            thresholds={{
              minPrecision: view.settings.minPrecision,
              minMonths: view.settings.minMonths,
              minDecisions: view.settings.minDecisions,
            }}
          />
          <AliasPanel
            aliases={view.aliases.map((a) => ({
              id: a.id,
              payerKey: a.payerKey,
              alias: a.alias,
              status: a.status,
              made: a.made,
              undone: a.undone,
            }))}
            payers={payers}
            canManage={canManage}
            canApprove={canApprove}
          />
        </div>
      )}
    </div>
  );
}
