import "server-only";

import { createHash, randomUUID } from "node:crypto";

import {
  basicAuthMatches,
  checkAttachment,
  domainOf,
  MAILBOX_KIND,
  MAILBOX_MAX_REQUEST_BYTES,
  parseAllowList,
  parsePostmarkInbound,
  senderAllowed,
  type InboundMessage,
  type MailboxType,
} from "@/lib/finance/mailbox";
import { bumpUsage } from "@/lib/integrations/accounts";
import type { WebhookSpec } from "@/lib/integrations/webhook-route";
import { FINANCE_DOCUMENT_BUCKET, financeDocumentPath } from "@/lib/media/paths";
import { removeObjects } from "@/lib/media/probe";
import type { MalwareScanner } from "@/lib/media/scan";
import { configuredScanner, scanColumns, scanStored } from "@/lib/media/server";
import type { AdminClient } from "@/lib/supabase/admin";
import { isTrainingOrg } from "@/lib/training/mode";

/**
 * The finance mailbox webhook (Phase 20B). The mail service (Postmark inbound) posts each message to
 * /api/webhooks/integrations/finance_mailbox/<account id> with HTTP basic auth; receiveIntegrationWebhook() does the 404 for an
 * unknown or switched-off account, the size cap, the per-IP and per-account limits and the once-per-MessageID claim.
 *
 * Here: a training workspace stores nothing; a sender who is not on the allow-list, or whose domain neither SPF nor DKIM
 * vouches for (a forged From), is acknowledged and dropped (counted);
 * each attachment is checked by its bytes and stored as an unlabelled finance document in the inbox (sender DOMAIN only).
 * Nothing of the message is logged or stored: no body, subject, address, name or file name. A storage failure throws, so
 * the claim is released and the provider retries; files already stored are then recognised by their sha256.
 */

type Outcome =
  "stored" | "duplicate" | "refused_size" | "refused_type" | "skipped_inline" | "infected";

/** Stores one checked attachment as a ready inbox document. Throws on a storage or database failure. */
export async function storeMailboxAttachment(
  admin: AdminClient,
  orgId: string,
  senderDomain: string,
  bytes: Uint8Array,
  type: MailboxType,
  scanner: MalwareScanner = configuredScanner(),
): Promise<Outcome> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { data: existing, error: lookupError } = await admin
    .from("fin_documents")
    .select("id")
    .eq("org_id", orgId)
    .eq("sha256", sha256)
    .maybeSingle();
  if (lookupError) throw new Error("mailbox lookup failed");
  if (existing) return "duplicate";

  const id = randomUUID();
  const path = financeDocumentPath(orgId, id, type.extension);
  const inserted = await admin.from("fin_documents").insert({
    id,
    org_id: orgId,
    kind: "unclassified",
    source: "email",
    storage_path: path,
    mime_type: type.mime,
    size_bytes: bytes.byteLength,
    inbox_at: new Date().toISOString(),
    sender_domain: senderDomain,
  });
  if (inserted.error) throw new Error("mailbox document row failed");
  const dropRow = () => admin.from("fin_documents").delete().eq("id", id).eq("status", "pending");

  const uploaded = await admin.storage
    .from(FINANCE_DOCUMENT_BUCKET)
    .upload(path, bytes, { contentType: type.mime, upsert: false });
  if (uploaded.error) {
    await dropRow();
    throw new Error("mailbox upload failed");
  }

  const scan = await scanStored(
    admin,
    { bucket: FINANCE_DOCUMENT_BUCKET, path, size: bytes.byteLength, mime: type.mime },
    scanner,
  );
  if (scan.verdict === "infected") {
    // never served, never kept
    await removeObjects(admin, FINANCE_DOCUMENT_BUCKET, [path]);
    await dropRow();
    return "infected";
  }
  const ready = await admin
    .from("fin_documents")
    .update({ status: "ready", sha256, ...scanColumns(scan) })
    .eq("id", id)
    .eq("status", "pending");
  if (ready.error) {
    await removeObjects(admin, FINANCE_DOCUMENT_BUCKET, [path]);
    await dropRow();
    if (ready.error.code === "23505") return "duplicate"; // the same file arrived at the same moment
    throw new Error("mailbox document save failed");
  }
  return "stored";
}

/** Handles one parsed message for the account's organisation; returns the outcome word kept with the MessageID. */
export async function handleMailboxMessage(
  admin: AdminClient,
  orgId: string,
  allowedSenders: unknown,
  msg: InboundMessage,
  scanner?: MalwareScanner,
): Promise<string> {
  const count = async (metric: string, n = 1) => {
    if (n > 0) await bumpUsage(admin, orgId, MAILBOX_KIND, metric, n);
  };
  if (await isTrainingOrg(admin, orgId)) {
    await count("refused_training");
    return "training";
  }
  const { entries } = parseAllowList(allowedSenders);
  // an allow-listed From address counts only when SPF or DKIM vouches for its domain (anyone can write a From line)
  if (!msg.senderAuthenticated || !senderAllowed(msg.senderEmail, entries)) {
    await count("dropped_sender");
    return "dropped_sender";
  }
  const domain = domainOf(msg.senderEmail!);
  const tally: Record<Outcome, number> = {
    stored: 0,
    duplicate: 0,
    refused_size: 0,
    refused_type: 0,
    skipped_inline: 0,
    infected: 0,
  };
  for (const a of msg.attachments) {
    const checked = checkAttachment(a);
    if (!checked.ok) tally[checked.reason]++;
    else
      tally[
        await storeMailboxAttachment(admin, orgId, domain, checked.bytes, checked.type, scanner)
      ]++;
  }
  await count("messages");
  for (const [metric, n] of Object.entries(tally)) await count(metric, n);
  return tally.stored > 0 ? "stored" : "nothing_stored";
}

/** The WebhookSpec for receiveIntegrationWebhook(). `scanner` is for tests. */
export function mailboxWebhookSpec(scanner?: MalwareScanner): WebhookSpec {
  return {
    kind: MAILBOX_KIND,
    provider: "postmark_inbound",
    maxBytes: MAILBOX_MAX_REQUEST_BYTES,
    verify: (ctx) => basicAuthMatches(ctx.headers.get("authorization"), ctx.secrets.webhook_secret),
    parse: (raw) => {
      const msg = parsePostmarkInbound(raw);
      return [{ key: msg.messageId, data: msg }];
    },
    handle: (event, ctx) =>
      handleMailboxMessage(
        ctx.admin,
        ctx.account.org_id,
        ctx.config.allowed_senders,
        event.data as InboundMessage,
        scanner,
      ),
  };
}
