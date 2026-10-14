import Link from "next/link";

import { ScanBadge } from "@/components/media/scan-badge";
import { EmptyState } from "@/components/shell/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { can, ForbiddenError } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { todayIn } from "@/lib/finance/action-support";
import { formatBytes } from "@/lib/media/limits";
import { recordAccess } from "@/lib/security/access-log";
import { createAdminClient } from "@/lib/supabase/admin";

import { InvoiceButton, type InvoiceOptions } from "../payables/forms";
import { DiscardButton, InboxDropZone, LabelSelect, OpenInboxButton } from "./inbox-ui";

export const metadata = { title: "Finance inbox" };
export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  "application/pdf": "PDF",
  "image/jpeg": "JPEG",
  "image/png": "PNG",
  "image/webp": "WebP",
  "image/heic": "HEIC",
  "image/heif": "HEIF",
  "text/csv": "CSV",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
};

export default async function FinanceInboxPage() {
  const member = await requireMember();
  if (!can(member, "finance.inbox.manage")) throw new ForbiddenError("finance.inbox.manage");
  const makeInvoice = can(member, "finance.payables.manage");

  const admin = createAdminClient(); // service role AFTER the permission check
  const [{ data: docs }, { data: suppliers }, { data: branches }, { data: recent }] =
    await Promise.all([
      admin
        .from("fin_documents")
        .select(
          "id, kind, source, sender_domain, mime_type, size_bytes, sha256, scan_status, inbox_at",
        )
        .eq("org_id", member.orgId)
        .eq("status", "ready")
        .not("inbox_at", "is", null)
        .is("routed_at", null)
        .order("inbox_at", { ascending: false })
        .limit(200),
      makeInvoice
        ? admin
            .from("fin_suppliers")
            .select("id, name, default_category")
            .eq("org_id", member.orgId)
            .eq("active", true)
            .order("name")
        : Promise.resolve({ data: [] }),
      makeInvoice
        ? admin
            .from("fin_ref_branches")
            .select("code, name")
            .eq("org_id", member.orgId)
            .order("code")
        : Promise.resolve({ data: [] }),
      makeInvoice
        ? admin
            .from("fin_supplier_invoices")
            .select("category")
            .eq("org_id", member.orgId)
            .order("invoice_date", { ascending: false })
            .limit(300)
        : Promise.resolve({ data: [] }),
    ]);
  await recordAccess(admin, member, { entity: "finance_document", action: "list" });

  const options: InvoiceOptions = {
    suppliers: suppliers ?? [],
    branches: branches ?? [],
    categories: [
      ...new Set(
        [
          ...(suppliers ?? []).map((s) => s.default_category),
          ...(recent ?? []).map((i) => i.category),
        ].filter((x): x is string => !!x),
      ),
    ].sort(),
    today: todayIn(member.org.timezone),
  };
  const when = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: member.org.timezone || "UTC",
  });

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Finance inbox"
        description="Supplier invoices, bank statements and processor reports waiting to be dealt with: attachments e-mailed to the accounts mailbox by the allowed senders, and files dropped here (for example a photo of a paper invoice from a branch)."
      />
      <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
        Patient reports never go here. Diligence files, remittance advice and lab reports with
        patient names are uploaded on their own pages (
        <Link className="underline" href="/finance/upload">
          Insurance upload
        </Link>
        ,{" "}
        <Link className="underline" href="/finance/remittance">
          Remittance
        </Link>
        ), which read them and delete the original at once. Files here are kept as evidence.
      </p>
      <InboxDropZone />
      {makeInvoice && options.suppliers.length === 0 && (
        <p className="text-muted-foreground text-sm">
          To make a supplier invoice, add the supplier first (
          <Link className="underline" href="/finance/suppliers">
            Suppliers
          </Link>
          ).
        </p>
      )}
      <Card>
        <CardContent className="overflow-x-auto pt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Received</TableHead>
                <TableHead>From</TableHead>
                <TableHead>Type</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead>Label</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(docs ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6}>
                    <EmptyState title="The inbox is empty" className="border-0 p-6" />
                  </TableCell>
                </TableRow>
              ) : (
                (docs ?? []).map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="text-xs whitespace-nowrap">
                      {d.inbox_at ? when.format(new Date(d.inbox_at)) : "-"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {d.source === "email"
                        ? `E-mail from ${d.sender_domain ?? "?"}`
                        : "Dropped here"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {TYPE_LABEL[d.mime_type] ?? d.mime_type}{" "}
                      {d.scan_status !== "clean" && <ScanBadge status={d.scan_status} />}
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {formatBytes(Number(d.size_bytes))}
                    </TableCell>
                    <TableCell>
                      <LabelSelect id={d.id} kind={d.kind} />
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {d.scan_status !== "infected" && <OpenInboxButton id={d.id} />}
                      {makeInvoice && options.suppliers.length > 0 && d.sha256 && (
                        <InvoiceButton
                          trigger="Make a supplier invoice"
                          options={options}
                          document={{
                            id: d.id,
                            kind: d.kind,
                            sha256: d.sha256,
                            size: Number(d.size_bytes),
                            scan: d.scan_status,
                          }}
                        />
                      )}
                      <DiscardButton id={d.id} />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
