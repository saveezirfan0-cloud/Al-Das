import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { selectClass } from "@/components/finance/forms";
import {
  loadCustomers,
  loadOpenInvoices,
  loadReceiptAccounts,
} from "@/lib/accounting/receivables-server";
import { ForbiddenError, can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

import { ReceiptForm } from "../receipt-form";

export const metadata = { title: "New receipt" };
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NewReceiptPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string }>;
}) {
  const member = await requireMember();
  if (!can(member, "accounting.receipts.manage"))
    throw new ForbiddenError("accounting.receipts.manage");
  const sp = await searchParams;
  const admin = createAdminClient(); // service role AFTER the permission check
  const customers = (await loadCustomers(admin, member.orgId)).filter((c) => c.active);
  const customer = customers.find((c) => UUID.test(sp.customer ?? "") && c.id === sp.customer) ?? null;
  const [accounts, invoices] = customer
    ? await Promise.all([
        loadReceiptAccounts(admin, member.orgId),
        loadOpenInvoices(admin, member.orgId, customer.id),
      ])
    : [[], []];

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="New receipt"
        description="Choose the customer, then enter what was received. It is allocated to the oldest open invoice first unless you change the amounts; anything left stays on account."
      />
      <form method="get" className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Customer</span>
          <select name="customer" defaultValue={customer?.id ?? ""} className={`${selectClass} w-72`}>
            <option value="">Choose a customer</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="secondary">
          Continue
        </Button>
      </form>
      {customer && (
        <Card>
          <CardContent className="pt-6">
            {accounts.length === 0 ? (
              <p className="text-sm">
                There is no active bank, cash or clearing ledger to receive into. Add one in the chart of accounts.
              </p>
            ) : (
              <ReceiptForm
                key={customer.id}
                customerId={customer.id}
                accounts={accounts}
                invoices={invoices}
                today={new Date().toISOString().slice(0, 10)}
              />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
