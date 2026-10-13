"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import {
  cancelPaymentLink,
  lookupPaymentInvoice,
  sendPaymentLink,
  type LookupResult,
} from "./actions";

export type RequestRow = {
  id: string;
  invoiceNumber: string;
  amount: string;
  status: string;
  needsReview: boolean;
  reviewReason: string | null;
  createdAt: string;
  expiresAt: string | null;
  paidAt: string | null;
  provider: string;
};

const STATUS: Record<string, "secondary" | "success" | "warning" | "destructive" | "outline"> = {
  pending: "secondary",
  created: "secondary",
  sent: "warning",
  paid: "success",
  failed: "destructive",
  expired: "outline",
  cancelled: "outline",
};

const REASON: Record<string, string> = {
  amount_mismatch: "Amount or currency differs from the request",
  amount_missing: "The gateway sent no amount",
  paid_after_expired: "Paid after the link expired",
  paid_after_cancelled: "Paid after it was cancelled",
  paid_after_failed: "Paid after it was marked failed",
  paid_after_expiry: "Paid after the link expired",
};

export function PaymentLinks({ enabled, rows }: { enabled: boolean; rows: RequestRow[] }) {
  const [pending, start] = useTransition();
  const [number, setNumber] = useState("");
  const [amount, setAmount] = useState("");
  const [found, setFound] = useState<Extract<LookupResult, { ok: true }> | null>(null);
  const [checked, setChecked] = useState(false);

  function lookup() {
    start(async () => {
      const r = await lookupPaymentInvoice(number);
      if (!r.ok) {
        setFound(null);
        return void toast.error(r.error);
      }
      setFound(r);
      setChecked(false);
      if (r.total && !amount) setAmount(r.total);
    });
  }

  function send() {
    start(async () => {
      const r = await sendPaymentLink({ invoiceNumber: number, amount });
      if (r.ok) {
        toast.success(r.message);
        setNumber("");
        setAmount("");
        setFound(null);
        setChecked(false);
      } else toast.error(r.error);
    });
  }

  function cancel(id: string) {
    start(async () => {
      const r = await cancelPaymentLink({ id });
      if (r.ok) toast.success(r.message);
      else toast.error(r.error);
    });
  }

  const blocked = !found || !found.hasPatient || found.hasLiveRequest;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>New payment link</CardTitle>
          <CardDescription>
            Find the invoice, check the amount, then send. The amount cannot be more than the
            invoice total.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex max-w-md items-end gap-2">
            <div className="grid flex-1 gap-1">
              <Label htmlFor="pl-number">Invoice number</Label>
              <Input
                id="pl-number"
                autoComplete="off"
                value={number}
                onChange={(e) => {
                  setNumber(e.target.value);
                  setFound(null);
                }}
              />
            </div>
            <Button
              variant="outline"
              disabled={pending || !number.trim() || !enabled}
              onClick={lookup}
            >
              Find
            </Button>
          </div>
          {found && (
            <div className="flex max-w-md flex-col gap-3">
              <p className="text-sm">
                Invoice <strong>{found.number}</strong>
                {found.total ? (
                  <>
                    {" "}
                    total {found.currency} {found.total}
                  </>
                ) : null}
                .
                {!found.hasPatient && (
                  <span className="text-destructive">
                    {" "}
                    It has no patient, so there is nobody to send it to.
                  </span>
                )}
                {found.hasLiveRequest && (
                  <span className="text-destructive">
                    {" "}
                    A payment link is already open for it; cancel that one first.
                  </span>
                )}
              </p>
              <div className="grid gap-1">
                <Label htmlFor="pl-amount">Amount to request ({found.currency})</Label>
                <Input
                  id="pl-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={checked}
                  onChange={(e) => setChecked(e.target.checked)}
                />
                <span>
                  I have checked the invoice number and the amount, and the patient should be asked
                  to pay now.
                </span>
              </label>
              <div>
                <Button
                  disabled={pending || blocked || !checked || !amount.trim() || !enabled}
                  onClick={send}
                >
                  {pending && <Loader2 className="animate-spin" />} Send payment link on WhatsApp
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent links</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-muted-foreground text-sm">No payment links yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{r.invoiceNumber}</TableCell>
                    <TableCell className="tabular-nums">{r.amount}</TableCell>
                    <TableCell className="flex flex-wrap items-center gap-1">
                      <Badge variant={STATUS[r.status] ?? "outline"}>{r.status}</Badge>
                      {r.needsReview && (
                        <Badge
                          variant="destructive"
                          title={REASON[r.reviewReason ?? ""] ?? "Needs review"}
                        >
                          review
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {new Date(r.createdAt).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {r.expiresAt ? new Date(r.expiresAt).toLocaleString() : ""}
                    </TableCell>
                    <TableCell>
                      {["pending", "created", "sent"].includes(r.status) && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() => cancel(r.id)}
                        >
                          Cancel
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
