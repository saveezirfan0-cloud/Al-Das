import Link from "next/link";

import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { can } from "@/lib/auth/can";
import { requireMember } from "@/lib/auth/session";
import { contactDisplayName } from "@/lib/inbox/contact-name";
import { createClient } from "@/lib/supabase/server";
import { mapMetaError } from "@/lib/whatsapp/errors";

import { RetryButton } from "./retry-button";

export const metadata = { title: "Failed messages" };
export const dynamic = "force-dynamic";

export default async function FailedMessagesPage() {
  const member = await requireMember();
  const supabase = await createClient();
  const { data: rows } = await supabase
    .from("messages")
    .select(
      "id, kind, body, error_code, error_message, at, conversation_id, conversations(id, contacts(first_name, last_name, wa_profile_name, phone_e164), channels(name))",
    )
    .eq("org_id", member.orgId)
    .eq("direction", "out")
    .eq("status", "failed")
    .order("at", { ascending: false })
    .limit(200);

  const canRetry = can(member, "inbox.send");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Failed messages"
        description="Outbound WhatsApp messages Meta rejected or could not deliver. Window and opt-out failures need a template or consent, not a retry."
      >
        <Button asChild variant="outline" size="sm">
          <Link href="/inbox">Back to inbox</Link>
        </Button>
      </PageHeader>
      {!rows || rows.length === 0 ? (
        <p className="text-muted-foreground rounded-xl border border-dashed p-10 text-center text-sm">
          No failed messages. 🎉
        </p>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Patient</TableHead>
                <TableHead>Number</TableHead>
                <TableHead>Message</TableHead>
                <TableHead>Error</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((m) => {
                const mapped = mapMetaError(m.error_code);
                const contact = m.conversations?.contacts;
                return (
                  <TableRow key={m.id}>
                    <TableCell className="whitespace-nowrap">
                      {new Date(m.at).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Link href={`/inbox?c=${m.conversation_id}`} className="hover:underline">
                        {contact ? contactDisplayName(contact) : "Unknown"}
                      </Link>
                    </TableCell>
                    <TableCell>{m.conversations?.channels?.name ?? "—"}</TableCell>
                    <TableCell className="max-w-64 truncate">
                      <Badge variant="outline" className="mr-1">
                        {m.kind}
                      </Badge>
                      {m.body ?? ""}
                    </TableCell>
                    <TableCell className="max-w-80">
                      <span className="block text-xs">
                        {m.error_code && m.error_code > 0 ? `${m.error_code} · ` : ""}
                        {m.error_message ?? mapped.message}
                      </span>
                      <Badge
                        variant={mapped.category === "recipient" ? "warning" : "secondary"}
                        className="mt-1"
                      >
                        {mapped.category}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {canRetry && !mapped.requiresTemplate && !mapped.stopMarketing && (
                        <RetryButton messageId={m.id} />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
