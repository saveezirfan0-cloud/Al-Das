import "server-only";

import { recordAudit } from "@/lib/audit";
import { addTimelineEvent } from "@/lib/contacts/timeline";
import { readDocumentSettings } from "@/lib/documents/settings";
import {
  bumpUsage,
  dbBreakerStore,
  dbCallSink,
  loadAccount,
  readConfig,
  readSecrets,
  recordFailure,
  recordOk,
  type AccountRow,
} from "@/lib/integrations/accounts";
import { readEsignConfig } from "@/lib/integrations/esign/config";
import {
  createDropboxSignProvider,
  parseCallback,
  verifyEventHash,
  type CallbackEvent,
} from "@/lib/integrations/esign/dropbox-sign";
import {
  ESIGN_MESSAGE,
  ESIGN_TITLE,
  maskEmail,
  normalizeSignerEmail,
  normalizeSignerName,
} from "@/lib/integrations/esign/signer";
import { canMoveEsign, outcomeForEvent, type EsignStatus } from "@/lib/integrations/esign/state";
import type { EsignStorage } from "@/lib/integrations/esign/storage";
import { storeSignedPdf } from "@/lib/integrations/esign/store-signed";
import type { ESignProvider } from "@/lib/integrations/esign/types";
import type { WebhookSpec } from "@/lib/integrations/webhook-route";
import { DOCUMENT_BUCKET, LIBRARY_BUCKET } from "@/lib/media/paths";
import { notify } from "@/lib/notify/dispatch-db";
import { redactText } from "@/lib/redact";
import type { AdminClient } from "@/lib/supabase/admin";
import { isTrainingOrg } from "@/lib/training/mode";

/**
 * E-signature for consent forms, server side.
 *
 *   createEsignRequest   a member of staff with documents.manage sends one PDF (the patient's own consent document, or a form from the
 *                        Media Library) to the provider for ONE signer. What the provider receives: the document (through a 10 minute
 *                        link), the signer's name and e-mail, a fixed generic title and message. No clinical information, no patient id.
 *   applyEsignEvent      the provider's signed webhook: signed / declined / expired / cancelled. Forward only, idempotent. "Signed" fetches
 *                        the signed PDF through the shared client and stores it as a new patient document through the Phase 16 checks.
 *   cancelEsignRequest   withdraws a request that is still waiting.
 *
 * Patient documents must be switched on (Settings, Patient documents); training workspaces never send anything.
 */

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

export type ProviderDeps = { provider?: ESignProvider; storage: EsignStorage };

/** The configured provider with call logging and the stored breaker, or null while the key is missing. */
export function buildEsignProvider(admin: AdminClient, account: AccountRow): ESignProvider | null {
  const secrets = readSecrets(account);
  return createDropboxSignProvider({
    apiKey: secrets.api_key ?? "",
    sink: dbCallSink(admin, account.org_id),
    breaker: dbBreakerStore(admin, account.org_id, "esign"),
  });
}

async function documentsEnabled(admin: AdminClient, orgId: string): Promise<boolean> {
  const { data } = await admin.from("orgs").select("settings").eq("id", orgId).maybeSingle();
  return readDocumentSettings(data?.settings).enabled;
}

export type SourceRef =
  { kind: "patient_document"; id: string } | { kind: "library_asset"; id: string };

type LoadedSource = { bucket: string; path: string; ok: true } | { ok: false; error: string };

async function loadSource(
  admin: AdminClient,
  orgId: string,
  contactId: string,
  source: SourceRef,
): Promise<LoadedSource> {
  if (source.kind === "patient_document") {
    const { data } = await admin
      .from("patient_documents")
      .select("id, category, mime_type, status, scan_status, storage_path, contact_id")
      .eq("id", source.id)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!data || data.status !== "ready" || data.contact_id !== contactId)
      return { ok: false, error: "That document was not found for this patient." };
    if (data.category !== "consent")
      return { ok: false, error: "Only a consent form can be sent for signature." };
    if (data.mime_type !== "application/pdf")
      return { ok: false, error: "Only a PDF can be sent for signature." };
    if (data.scan_status === "infected")
      return { ok: false, error: "The malware scan blocked that file." };
    return { ok: true, bucket: DOCUMENT_BUCKET, path: data.storage_path };
  }
  const { data } = await admin
    .from("media_assets")
    .select("id, kind, mime_type, status, scan_status, storage_path")
    .eq("id", source.id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!data || data.status !== "ready" || data.kind !== "document")
    return { ok: false, error: "That form was not found in the Media Library." };
  if (data.mime_type !== "application/pdf")
    return { ok: false, error: "Only a PDF can be sent for signature." };
  if (data.scan_status === "infected")
    return { ok: false, error: "The malware scan blocked that file." };
  return { ok: true, bucket: LIBRARY_BUCKET, path: data.storage_path };
}

export async function createEsignRequest(
  admin: AdminClient,
  deps: ProviderDeps,
  a: {
    orgId: string;
    actorId: string;
    contactId: string;
    source: SourceRef;
    signerName: string;
    signerEmail: string;
    now?: Date;
  },
): Promise<Result<{ requestId: string }>> {
  const now = a.now ?? new Date();
  if (!(await documentsEnabled(admin, a.orgId)))
    return {
      ok: false,
      error:
        "Patient documents are switched off. An administrator can turn them on under Settings, Patient documents.",
    };
  const account = await loadAccount(admin, a.orgId, "esign");
  if (!account?.enabled)
    return {
      ok: false,
      error:
        "E-signature is switched off. An administrator can turn it on in Settings, Integrations.",
    };
  if (await isTrainingOrg(admin, a.orgId)) {
    await bumpUsage(admin, a.orgId, "esign", "blocked_training");
    return {
      ok: false,
      error: "This is a training workspace: nothing is sent for signature here.",
    };
  }
  const cfg = readEsignConfig(readConfig(account));
  const provider = deps.provider ?? buildEsignProvider(admin, account);
  if (!provider) return { ok: false, error: "The e-signature settings are incomplete." };

  const name = normalizeSignerName(a.signerName);
  const email = normalizeSignerEmail(a.signerEmail);
  if (!name) return { ok: false, error: "Enter the signer's name." };
  if (!email) return { ok: false, error: "Enter a valid e-mail address for the signer." };

  const { data: contact } = await admin
    .from("contacts")
    .select("id, erased_at, deleted_at, merged_into_id")
    .eq("id", a.contactId)
    .eq("org_id", a.orgId)
    .maybeSingle();
  if (!contact || contact.erased_at || contact.deleted_at || contact.merged_into_id)
    return { ok: false, error: "Patient not found." };

  const source = await loadSource(admin, a.orgId, a.contactId, a.source);
  if (!source.ok) return source;

  const expiresAt = new Date(now.getTime() + cfg.expiryDays * 86_400_000);
  const { data: row, error } = await admin
    .from("esign_requests")
    .insert({
      org_id: a.orgId,
      contact_id: a.contactId,
      requested_by: a.actorId,
      provider: "dropbox_sign",
      source_kind: a.source.kind,
      source_document_id: a.source.kind === "patient_document" ? a.source.id : null,
      source_asset_id: a.source.kind === "library_asset" ? a.source.id : null,
      status: "creating",
      signer_hint: maskEmail(email),
      test_mode: cfg.testMode,
      expires_at: expiresAt.toISOString(),
    })
    .select("id")
    .single();
  if (error || !row) return { ok: false, error: "Could not start the request." };
  const requestId = row.id;
  const stop = async (code: string, message: string, status: EsignStatus = "failed") => {
    await admin
      .from("esign_requests")
      .update({ status, error_code: code.slice(0, 40) })
      .eq("id", requestId)
      .eq("status", "creating");
    return { ok: false as const, error: message };
  };

  const fileUrl = await deps.storage.signedUrl(source.bucket, source.path, 600);
  if (!fileUrl) return stop("source_unreadable", "The document could not be read from storage.");

  const created = await provider.createRequest({
    title: ESIGN_TITLE,
    message: ESIGN_MESSAGE,
    signer: { name, email },
    fileUrl,
    expiresAt,
    clientRef: requestId,
    testMode: cfg.testMode,
  });
  if (!created.ok) {
    await recordFailure(admin, a.orgId, "esign", `e-signature provider error ${created.code}`);
    await bumpUsage(admin, a.orgId, "esign", "create_failed");
    if (created.ambiguous)
      return stop(
        "unknown_delivery",
        "The provider did not answer, so it is not known whether the signer was e-mailed. Check the provider before sending again.",
      );
    return stop(
      created.code,
      created.code === "auth"
        ? "The e-signature provider rejected the credentials."
        : created.code === "unsupported_signer"
          ? "This provider needs an e-mail address for the signer."
          : "The e-signature provider did not accept the request. Nothing was sent.",
    );
  }
  const { error: saveError } = await admin
    .from("esign_requests")
    .update({
      status: "pending",
      provider_request_id: created.providerRequestId,
      sent_at: now.toISOString(),
      error_code: null,
    })
    .eq("id", requestId)
    .eq("status", "creating");
  if (saveError) {
    // Without the provider's id a later callback could not be matched: withdraw it rather than leave an orphan.
    await provider.cancelRequest(created.providerRequestId);
    return stop(
      "reference_not_stored",
      "The request could not be recorded, so it was withdrawn. Try again.",
    );
  }
  await recordOk(admin, a.orgId, "esign");
  await bumpUsage(admin, a.orgId, "esign", "requests_created");
  await addTimelineEvent(admin, {
    orgId: a.orgId,
    contactId: a.contactId,
    type: "esign.requested",
    actorId: a.actorId,
    payload: { request_id: requestId },
  });
  return { ok: true, requestId };
}

export async function cancelEsignRequest(
  admin: AdminClient,
  deps: Pick<ProviderDeps, "provider">,
  a: { orgId: string; actorId: string | null; requestId: string },
): Promise<Result<{ providerCancelled: boolean }>> {
  const { data: req } = await admin
    .from("esign_requests")
    .select("id, status, provider_request_id, contact_id")
    .eq("id", a.requestId)
    .eq("org_id", a.orgId)
    .maybeSingle();
  if (!req) return { ok: false, error: "Request not found." };
  if (req.status !== "pending")
    return { ok: false, error: "Only a request that is waiting for a signature can be cancelled." };
  let providerCancelled = false;
  if (req.provider_request_id) {
    const account = await loadAccount(admin, a.orgId, "esign");
    const provider = deps.provider ?? (account ? buildEsignProvider(admin, account) : null);
    if (!provider) return { ok: false, error: "The e-signature settings are incomplete." };
    const r = await provider.cancelRequest(req.provider_request_id);
    if (!r.ok)
      return {
        ok: false,
        error: "The provider could not cancel the request. Try again in a moment.",
      };
    providerCancelled = true;
  }
  const { data: updated } = await admin
    .from("esign_requests")
    .update({ status: "cancelled", completed_at: new Date().toISOString() })
    .eq("id", req.id)
    .eq("org_id", a.orgId)
    .eq("status", "pending")
    .select("id");
  if (!updated?.length) return { ok: false, error: "The request was already completed." };
  await addTimelineEvent(admin, {
    orgId: a.orgId,
    contactId: req.contact_id,
    type: "esign.cancelled",
    actorId: a.actorId,
    payload: { request_id: req.id },
  });
  return { ok: true, providerCancelled };
}

/** Best effort before an erasure: withdraw requests that are still waiting. The rows themselves are deleted by erase_contact. */
export async function cancelPendingForErasure(
  admin: AdminClient,
  deps: Pick<ProviderDeps, "provider">,
  a: { orgId: string; contactId: string },
): Promise<{ cancelled: number; failed: number }> {
  const { data: open } = await admin
    .from("esign_requests")
    .select("id")
    .eq("org_id", a.orgId)
    .eq("contact_id", a.contactId)
    .eq("status", "pending");
  let cancelled = 0;
  let failed = 0;
  for (const r of open ?? []) {
    const res = await cancelEsignRequest(admin, deps, {
      orgId: a.orgId,
      actorId: null,
      requestId: r.id,
    }).catch(() => null);
    if (res?.ok) cancelled++;
    else failed++;
  }
  return { cancelled, failed };
}

async function tell(
  admin: AdminClient,
  req: { id: string; org_id: string; requested_by: string | null },
): Promise<void> {
  if (!req.requested_by) return;
  await notify(admin, {
    orgId: req.org_id,
    userIds: [req.requested_by],
    event: "esign.update",
    type: "esign.update",
    title: "Signature update",
    body: "A consent form you sent for signature has an update.",
    payload: { request_id: req.id },
    ids: {},
  });
}

/** Applies one verified provider event. Returns a short outcome word for the idempotency record; throws when the provider should retry. */
export async function applyEsignEvent(
  admin: AdminClient,
  deps: ProviderDeps,
  a: { orgId: string; accountRow: AccountRow; event: CallbackEvent; now?: Date },
): Promise<string> {
  const { event } = a;
  const outcome = outcomeForEvent(event.eventType, event.isComplete);
  if (!outcome) return "ignored";
  if (!event.requestId) return "no_request";

  let { data: req } = await admin
    .from("esign_requests")
    .select("id, org_id, contact_id, requested_by, status, provider_request_id")
    .eq("org_id", a.orgId)
    .eq("provider", "dropbox_sign")
    .eq("provider_request_id", event.requestId)
    .maybeSingle();
  if (!req && event.clientRef && /^[0-9a-f-]{36}$/i.test(event.clientRef)) {
    // The callback beat our own bookkeeping: match by the id we put in the provider's metadata.
    const found = await admin
      .from("esign_requests")
      .select("id, org_id, contact_id, requested_by, status, provider_request_id")
      .eq("org_id", a.orgId)
      .eq("id", event.clientRef)
      .is("provider_request_id", null)
      .maybeSingle();
    req = found.data;
    if (req)
      await admin
        .from("esign_requests")
        .update({ provider_request_id: event.requestId })
        .eq("id", req.id)
        .is("provider_request_id", null);
  }
  if (!req) return "unknown_request";
  if (outcome === "partly_signed") return "partly_signed";

  let status = req.status as EsignStatus;
  if (status === "creating") {
    await admin
      .from("esign_requests")
      .update({ status: "pending", provider_request_id: event.requestId })
      .eq("id", req.id)
      .eq("status", "creating");
    status = "pending";
  }
  if (!canMoveEsign(status, outcome)) return `already_${status}`;

  const when = (a.now ?? new Date()).toISOString();
  if (outcome === "signed") {
    const account = a.accountRow;
    const provider = deps.provider ?? buildEsignProvider(admin, account);
    if (!provider) throw new Error("e-signature provider not configured");
    const file = await provider.fetchSignedPdf(event.requestId);
    let documentId: string | null = null;
    let errorCode: string | null = null;
    if (!file.ok) {
      // A temporary problem is retried by the provider (this throws); a permanent one is recorded and staff are told.
      if (file.retryable) throw new Error(`signed file not available (${file.code}); will retry`);
      errorCode = `file_${file.code}`.slice(0, 40);
    } else {
      const { data: org } = await admin
        .from("orgs")
        .select("timezone")
        .eq("id", a.orgId)
        .maybeSingle();
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: org?.timezone ?? "UTC" }).format(
        new Date(when),
      );
      const stored = await storeSignedPdf(admin, deps.storage, {
        orgId: a.orgId,
        contactId: req.contact_id,
        requestId: req.id,
        bytes: file.bytes,
        title: `Signed consent form, ${day}`,
        uploadedBy: req.requested_by,
      });
      if (stored.ok) documentId = stored.documentId;
      else if (stored.reason === "storage_failed")
        throw new Error("could not store the signed file; will retry");
      else errorCode = `store_${stored.reason}`.slice(0, 40);
    }
    const { data: moved } = await admin
      .from("esign_requests")
      .update({
        status: "signed",
        signed_document_id: documentId,
        completed_at: when,
        error_code: errorCode,
      })
      .eq("id", req.id)
      .eq("status", "pending")
      .select("id");
    if (!moved?.length) return "already_final";
    await bumpUsage(admin, a.orgId, "esign", "signed");
    await recordAudit(admin, {
      orgId: a.orgId,
      userId: null,
      action: "esign.signed",
      entity: "esign_request",
      entityId: req.id,
      diff: { contact_id: req.contact_id, stored: !!documentId },
    });
    await addTimelineEvent(admin, {
      orgId: a.orgId,
      contactId: req.contact_id,
      type: "esign.signed",
      actorType: "system",
      payload: { request_id: req.id, document_id: documentId },
    });
    await tell(admin, req);
    return documentId ? "applied_signed" : "signed_without_copy";
  }

  const { data: moved } = await admin
    .from("esign_requests")
    .update({ status: outcome, completed_at: when })
    .eq("id", req.id)
    .eq("status", "pending")
    .select("id");
  if (!moved?.length) return "already_final";
  await bumpUsage(admin, a.orgId, "esign", outcome);
  await recordAudit(admin, {
    orgId: a.orgId,
    userId: null,
    action: `esign.${outcome}`,
    entity: "esign_request",
    entityId: req.id,
    diff: { contact_id: req.contact_id },
  });
  await addTimelineEvent(admin, {
    orgId: a.orgId,
    contactId: req.contact_id,
    type: `esign.${outcome}`,
    actorType: "system",
    payload: { request_id: req.id },
  });
  if (outcome !== "cancelled") await tell(admin, req);
  return `applied_${outcome}`;
}

/** The inbound callback: Dropbox Sign's event hash, an HMAC of the event time and type with the API key, is checked in constant time. */
export function esignWebhookSpec(deps: {
  provider?: ESignProvider;
  storage: () => EsignStorage;
  admin?: AdminClient;
}): WebhookSpec {
  return {
    kind: "esign",
    provider: "dropbox_sign",
    successBody: "Hello API Event Received",
    verify(ctx) {
      const e = parseCallback(ctx.raw, ctx.headers.get("content-type"));
      return (
        !!e &&
        verifyEventHash(ctx.secrets.api_key ?? "", {
          event_time: e.eventTime,
          event_type: e.eventType,
          event_hash: e.eventHash,
        })
      );
    },
    parse(raw, ctx) {
      const e = parseCallback(raw, ctx.headers.get("content-type"));
      if (!e) throw new Error("not a callback event");
      return [{ key: `${e.requestId ?? "none"}:${e.eventType}:${e.eventTime}`, data: e }];
    },
    async handle(event, ctx) {
      try {
        return await applyEsignEvent(
          ctx.admin,
          { provider: deps.provider, storage: deps.storage() },
          {
            orgId: ctx.account.org_id,
            accountRow: ctx.account,
            event: event.data as CallbackEvent,
          },
        );
      } catch (err) {
        console.error("[esign] event could not be applied", { error: redactText(err, 120) });
        throw err;
      }
    },
  };
}
