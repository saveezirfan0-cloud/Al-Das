import Link from "next/link";

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
import { RULE_KINDS } from "@/lib/accounting/posting/rules";
import { loadLedgerStart, loadPostingRulesView } from "@/lib/accounting/posting/server";
import { POSTING_SOURCE_LABELS, RULE_KIND_LIST } from "@/lib/accounting/posting/types";
import { can, canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { DeleteRuleButton, RuleButton, SeedRulesButton, SettingsForm } from "./forms";

export const metadata = { title: "Posting rules" };
export const dynamic = "force-dynamic";

export default async function PostingRulesPage() {
  const member = await requireMember();
  if (!canAny(member, ["accounting.settings.manage", "accounting.view"]))
    throw new ForbiddenError("accounting.view");
  const manage = can(member, "accounting.settings.manage");
  const admin = createAdminClient(); // service role AFTER the permission check
  const [view, ledgerStart] = await Promise.all([
    loadPostingRulesView(admin, member.orgId),
    loadLedgerStart(admin, member.orgId),
  ]);
  const { rules, accounts, taxCodes, settings, missing } = view;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Posting rules"
        description="Which account (and VAT code) each amount from Unite, payables, banking, the revenue share, labs and cash-ups posts to. Rules are data: '*' means any, and the most specific rule wins."
      >
        {manage && (
          <div className="flex flex-wrap gap-2">
            <SeedRulesButton />
            <RuleButton accounts={accounts} taxCodes={taxCodes} />
          </div>
        )}
      </PageHeader>

      <p className="text-muted-foreground text-sm">
        {ledgerStart
          ? `Pulse posts items dated from ${ledgerStart}; earlier items are previewed only (Tally holds them).`
          : "No ledger start is set: Tally is the book of record and every item is previewed only. Set the start under Entities and fiscal years."}{" "}
        <Link className="underline" href="/accounting/waiting">
          Waiting to post
        </Link>{" "}
        lists what a missing rule holds up.
      </p>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Not mapped yet{" "}
            {missing.length > 0 ? (
              <Badge variant="warning" className="ml-1">
                {missing.length}
              </Badge>
            ) : (
              <Badge variant="success" className="ml-1">
                all mapped
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {missing.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Every category, payment mode and account the finance records use today has a rule.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kind</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>For</TableHead>
                  <TableHead>Effect</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {missing.map((m) => (
                  <TableRow key={`${m.kind}|${m.key}|${m.qualifier}`}>
                    <TableCell>{RULE_KINDS[m.kind].label}</TableCell>
                    <TableCell className="font-mono text-xs">{m.key}</TableCell>
                    <TableCell className="text-xs">
                      {m.qualifier === "*" ? "any" : m.qualifier}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">{m.why}</TableCell>
                    <TableCell className="text-right">
                      {manage && (
                        <RuleButton
                          trigger="Map"
                          rule={{
                            kind: m.kind,
                            key: m.key,
                            qualifier: m.qualifier.includes(",") ? "*" : m.qualifier,
                          }}
                          accounts={accounts}
                          taxCodes={taxCodes}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rules</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Qualifier</TableHead>
                <TableHead>Account</TableHead>
                <TableHead>Tax code</TableHead>
                <TableHead>From</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground text-sm">
                    No rules yet. Add the defaults to start.
                  </TableCell>
                </TableRow>
              )}
              {RULE_KIND_LIST.flatMap((k) => rules.filter((r) => r.kind === k)).map((r) => (
                <TableRow key={r.id} className={r.active ? "" : "opacity-60"}>
                  <TableCell>{RULE_KINDS[r.kind].label}</TableCell>
                  <TableCell className="font-mono text-xs">{r.key}</TableCell>
                  <TableCell className="font-mono text-xs">{r.qualifier}</TableCell>
                  <TableCell>
                    {r.account_code ? (
                      <>
                        <span className="font-mono text-xs">{r.account_code}</span> {r.account_name}
                      </>
                    ) : (
                      "-"
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{r.tax_code ?? "-"}</TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {r.origin === "seed"
                        ? "default"
                        : r.origin === "migrated"
                          ? "old map"
                          : "set by hand"}
                    </Badge>
                    {!r.active && (
                      <Badge variant="secondary" className="ml-1">
                        inactive
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {manage && (
                      <>
                        <RuleButton rule={r} accounts={accounts} taxCodes={taxCodes} />
                        <DeleteRuleButton id={r.id} />
                      </>
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
          <CardTitle className="text-base">Settings</CardTitle>
        </CardHeader>
        <CardContent>
          {manage ? (
            <SettingsForm settings={settings} />
          ) : (
            <ul className="text-sm">
              <li>
                Expected-rejection allowance: {settings.denialAllowanceEnabled ? "on" : "off"}
              </li>
              <li>Package invoices: {settings.packageInvoices === "post" ? "posted" : "held"}</li>
              <li>Rounding tolerance: {settings.roundingTolerance.toFixed(2)}</li>
              <li>VAT tolerance: {settings.vatTolerance.toFixed(2)}</li>
              <li>
                Paused:{" "}
                {settings.pausedSources.length
                  ? settings.pausedSources.map((s) => POSTING_SOURCE_LABELS[s]).join(", ")
                  : "none"}
              </li>
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
