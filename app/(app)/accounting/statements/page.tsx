import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmailDocumentButton } from "@/components/finance/email-document-button";
import { selectClass } from "@/components/finance/forms";
import { RECEIVABLES_READ } from "@/lib/accounting/nav";
import { loadCustomers, loadStatement } from "@/lib/accounting/receivables-server";
import { canAny, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { customerEmailProblem } from "@/lib/finance/document-email";
import { money } from "@/lib/finance/format";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

import { dateParam, RangeForm } from "../ui";
import { emailBalanceConfirmation, emailCustomerStatement } from "./actions";

export const metadata = { title: "Customer statements" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KIND_LABEL = { invoice: "Invoice", credit_note: "Credit note", receipt: "Receipt" } as const;

export default async function StatementsPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; from?: string; to?: string }>;
}) {
  const member = await requireMember();
  if (!canAny(member, RECEIVABLES_READ)) throw new ForbiddenError("accounting.reports.view");
  const sp = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const to = dateParam(sp.to, today);
  const from = dateParam(sp.from, `${to.slice(0, 4)}-01-01`);
  const customerId = UUID.test(sp.customer ?? "") ? sp.customer! : null;
  const admin = createAdminClient(); // service role AFTER the permission check
  const customers = await loadCustomers(admin, member.orgId);
  const s =
    customerId && from <= to ? await loadStatement(admin, member.orgId, customerId, from, to) : null;
  if (s) await recordAccess(admin, member, { entity: "accounting_receivable", action: "list" });
  const qs = s ? `customer=${s.customer.id}&from=${from}&to=${to}` : "";
  const emailProblem = s ? customerEmailProblem(s.customer) : null;
  const recipients = s?.customer.email ? [{ name: s.customer.name, email: s.customer.email }] : [];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Customer statements"
        description="A customer's invoices, credit notes and receipts with the running balance, as PDF or Excel, and a balance-confirmation letter for the auditors."
      >
        {s && (
          <>
            <Button asChild variant="outline" size="sm">
              <a href={`/api/accounting/statements?${qs}&format=pdf`}>PDF</a>
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href={`/api/accounting/statements?${qs}&format=xlsx`}>Excel</a>
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href={`/api/accounting/balance-confirmation?customer=${s.customer.id}&as_of=${to}`}>
                Balance confirmation
              </a>
            </Button>
            <EmailDocumentButton
              label="E-mail statement"
              title="E-mail the statement"
              description={`The statement for ${from} to ${to} goes out as a PDF from Pulse's address. Replies come back to the finance team.`}
              recipients={recipients}
              disabledReason={emailProblem}
              action={emailCustomerStatement.bind(null, {
                customerId: s.customer.id,
                from,
                to,
                recipient: s.customer.email ?? "",
              })}
            />
            <EmailDocumentButton
              label="E-mail balance confirmation"
              title="E-mail the balance confirmation"
              description={`The balance-confirmation letter as at ${to} goes out as a PDF, asking the customer to confirm the balance or report a difference.`}
              recipients={recipients}
              disabledReason={emailProblem}
              action={emailBalanceConfirmation.bind(null, {
                customerId: s.customer.id,
                asOf: to,
                recipient: s.customer.email ?? "",
              })}
            />
          </>
        )}
      </PageHeader>
      <RangeForm from={from} to={to}>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Customer</span>
          <select name="customer" defaultValue={customerId ?? ""} className={`${selectClass} w-64`}>
            <option value="">Choose a customer</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </RangeForm>
      {s && (
        <Card>
          <CardContent className="overflow-x-auto pt-6">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Document</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>{from}</TableCell>
                  <TableCell colSpan={4}>Opening balance</TableCell>
                  <TableCell className="text-right tabular-nums">{money(s.opening)}</TableCell>
                </TableRow>
                {s.rows.map((r, i) => (
                  <TableRow key={`${r.number}-${i}`}>
                    <TableCell className="whitespace-nowrap">{r.date}</TableCell>
                    <TableCell>
                      {KIND_LABEL[r.kind]} <span className="font-mono text-xs">{r.number}</span>
                    </TableCell>
                    <TableCell className="text-xs">{r.reference ?? ""}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.debit ? money(r.debit) : ""}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.credit ? money(r.credit) : ""}</TableCell>
                    <TableCell className="text-right tabular-nums">{money(r.balance)}</TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell>{to}</TableCell>
                  <TableCell colSpan={2} className="font-medium">
                    Closing balance
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(s.debits)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(s.credits)}</TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{money(s.closing)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
            <p className="text-muted-foreground mt-3 text-xs">
              A positive balance is owed by the customer; a negative one is money held for them.{" "}
              <Link className="underline" href={`/accounting/sales-invoices?customer=${s.customer.id}`}>
                Their invoices
              </Link>
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
