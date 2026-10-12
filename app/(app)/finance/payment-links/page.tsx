import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { can } from "@/lib/auth/can";
import { requirePerm } from "@/lib/auth/session";
import { isEnabled } from "@/lib/integrations/accounts";
import { minorToMajor } from "@/lib/integrations/payments/money";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { PaymentLinks, type RequestRow } from "./payment-links";

export const metadata = { title: "Payment links" };
export const dynamic = "force-dynamic";

export default async function PaymentLinksPage() {
  const member = await requirePerm("finance.payment_links");
  const enabled = await isEnabled(createAdminClient(), member.orgId, "payments");
  const supabase = await createClient(); // the member's own client: RLS decides who may read
  const { data } = await supabase
    .from("fin_payment_requests")
    .select(
      "id, invoice_number, amount_minor, currency, status, needs_review, review_reason, created_at, expires_at, paid_at, provider",
    )
    .order("created_at", { ascending: false })
    .limit(100);
  const rows: RequestRow[] = (data ?? []).map((r) => ({
    id: r.id,
    invoiceNumber: r.invoice_number,
    amount: `${r.currency} ${minorToMajor(Number(r.amount_minor), r.currency)}`,
    status: r.status,
    needsReview: r.needs_review,
    reviewReason: r.review_reason,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    paidAt: r.paid_at,
    provider: r.provider,
  }));
  const review = rows.filter((r) => r.needsReview).length;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Payment links"
        description="Send a patient a link to pay an invoice by card, in a WhatsApp message. Pulse records what the payment gateway reports; it never marks the invoice as paid in Unite, so reconcile paid links in your usual way."
      />
      {!enabled && (
        <Alert>
          <AlertTitle>Payment links are switched off</AlertTitle>
          <AlertDescription>
            An administrator turns them on in{" "}
            {can(member, "integrations.manage") ? (
              <Link className="underline" href="/settings/integrations/payments">
                Settings, Integrations
              </Link>
            ) : (
              "Settings, Integrations"
            )}
            , after choosing the gateway and the approved WhatsApp template.
          </AlertDescription>
        </Alert>
      )}
      {review > 0 && (
        <Alert variant="destructive">
          <AlertTitle>
            {review} payment{review === 1 ? "" : "s"} need review
          </AlertTitle>
          <AlertDescription>
            The gateway reported an amount that does not match the request, or a payment arrived
            after the link was closed. Check them in the gateway&apos;s dashboard before you
            reconcile.
          </AlertDescription>
        </Alert>
      )}
      <PaymentLinks enabled={enabled} rows={rows} />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">How this works</CardTitle>
          <CardDescription>A short reminder for the person sending links.</CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground flex flex-col gap-1 text-sm">
          <p>
            The message goes to the patient&apos;s WhatsApp (or the guardian&apos;s, for a child) as
            an approved template. It never contains a name from this screen.
          </p>
          <p>
            One open link per invoice. Cancel it before sending a new one. A link stops working when
            it expires.
          </p>
          <p>
            Status <Badge variant="outline">paid</Badge> is the gateway&apos;s word. Refunds are not
            handled here.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
