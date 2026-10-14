/**
 * Reviewed exceptions to the static security rules (lib/security/static-audit.ts).
 * Keys are "<file>::<entry point>". Every entry carries the reason a reviewer accepted it;
 * tests/unit/security-static.test.ts fails on stale entries so this list cannot rot.
 */

/** Entry points that legitimately have no authentication or authorisation call. */
export const UNGUARDED_OK: Record<string, string> = {
  "app/(auth)/login/actions.ts::signInWithPassword":
    "Pre-auth by definition; Supabase Auth verifies credentials. Rate-limited per IP and per e-mail.",
  "app/(auth)/login/actions.ts::sendMagicLink":
    "Pre-auth; shouldCreateUser is false. Rate-limited per IP and per e-mail.",
  "app/api/jobs/[queue]/route.ts::GET": "Returns 405.",
  "app/api/webhooks/meta/route.ts::GET":
    "Meta verification handshake; compares hub.verify_token and echoes the challenge only.",
  "app/(app)/settings/custom-fields/actions.ts::slugifyKey": "Pure string helper, touches no data.",
  "app/api/webhooks/in/[flowId]/route.ts::POST":
    "Authorised by a per-flow bearer token (192-bit random, only its SHA-256 stored, timing-safe compare); the same 401 for an unknown flow and a bad token; failed attempts are rate-limited per IP.",
  "app/api/calendar/[token]/route.ts::GET":
    "A calendar app cannot sign in: the 256-bit token in the path is the credential (only its SHA-256 is stored, revocable and rotatable). Every request is rate limited per IP and per token; unknown, revoked and switched-off feeds give the same 404; the feed holds times and the location name only.",
  "app/api/webhooks/integrations/sms/[accountId]/route.ts::POST":
    "Authorised by the provider's request signature (HMAC over the exact callback URL and form fields, constant-time compare) using the stored auth token; unknown or switched-off accounts give 404; failed signatures are rate limited per IP; each receipt is claimed once (integration_webhook_events).",
  "app/api/webhooks/integrations/esign/[accountId]/route.ts::POST":
    "Authorised by the provider's event hash (HMAC-SHA256 of the event time and type with the stored API key, constant-time compare); unknown or switched-off accounts give 404; failed hashes are rate limited per IP; each event is claimed once (integration_webhook_events) and moves a request forward only.",
  "app/api/webhooks/integrations/finance_mailbox/[accountId]/route.ts::POST":
    "Authorised by HTTP basic auth against the stored webhook password (constant-time compare); unknown or switched-off accounts give 404; bodies over 4.5 MB give 413; failed attempts are rate limited per IP and every account per minute; each message is claimed once by its MessageID (integration_webhook_events). Only attachments from allow-listed senders are kept (sender domain only), a training workspace stores nothing.",
  "app/api/tally-bridge/pair/route.ts::POST":
    "The Tally connector cannot sign in: it trades a one-time pairing code (about 78 bits, 30 minutes, single use, only its SHA-256 stored) that a person with accounting.settings.manage created, for a 256-bit device token returned once (only its SHA-256 stored, revocable). Every attempt is rate limited per IP; unknown, used and expired codes give the same 401.",
  "app/api/tally-bridge/jobs/route.ts::GET":
    "Authorised by the connector's device token (Bearer, 256 bits, only its SHA-256 stored and compared in the database, revocable); bad tokens are rate limited per IP and every token per minute; the organisation comes from the token and the integration switch is checked (403 when off). Hands out only the four allow-listed job types; imports only while pushing is allowed and before the ledger start.",
  "app/api/tally-bridge/results/route.ts::POST":
    "Authorised by the connector's device token like the jobs route; bodies over 4.4 MB give 413 and decompressed answers are capped; only a job sent to this connector and not yet answered is accepted (409 otherwise); Tally's XML is parsed only by lib/accounting/tally/ and applied through the idempotent 22I import path; Tally's error text is redacted before it is stored.",
  "app/api/webhooks/integrations/payments/[accountId]/route.ts::POST":
    "Authorised by the gateway's signature (Stripe-Signature with a 5 minute replay window, or the PayTabs HMAC) using the stored secret, constant-time compare; unknown or switched-off accounts give 404; failed signatures are rate limited per IP; each event is claimed once (integration_webhook_events) and amounts are checked against the stored request.",
};

/**
 * Entry points protected by authentication only (no permission key). Each acts on the
 * caller's own data, on a secret/signature, or is further constrained by RLS.
 */
export const AUTHN_ONLY_OK: Record<string, string> = {
  "app/(app)/contacts/actions.ts::saveGridPrefs":
    "Caller's own grid preferences (user_id = caller).",
  "app/(app)/inbox/actions.ts::saveInboxView":
    "Caller owns the view; updates are filtered by owner_id.",
  "app/(app)/inbox/actions.ts::deleteInboxView":
    "Deletes only the caller's own views (owner_id filter).",
  "app/(app)/inbox/actions.ts::listContactConversations":
    "Reads through the RLS client, so visibility rules apply.",
  "app/(app)/inbox/actions.ts::signedMediaUrl":
    "Strict path parse, org match, and the conversation must be visible to the caller through RLS.",
  "app/(app)/settings/account/actions.ts::updateProfile": "Caller's own profile.",
  "app/(app)/settings/account/actions.ts::changePassword":
    "Caller's own credentials; current password re-verified.",
  "app/(app)/settings/account/actions.ts::signOutThisDevice":
    "Ends the caller's own session only; writes an auth_events row.",
  "app/(app)/settings/account/actions.ts::signOutOtherDevices":
    "Ends the caller's own other sessions only; writes auth_events and audit_log rows.",
  "app/(app)/settings/account/actions.ts::signOutEverywhere":
    "Ends all of the caller's own sessions; writes auth_events and audit_log rows.",
  "app/(auth)/mfa/actions.ts::confirmMfaEnrolled":
    "Caller's own authenticator app; the server re-checks that Supabase Auth reports an aal2 session and a verified factor before writing the auth event.",
  "app/(auth)/mfa/actions.ts::confirmMfaVerified":
    "Caller's own session; the server re-checks aal2 before writing the auth event.",
  "app/(auth)/mfa/actions.ts::removeMfaFactor":
    "Caller's own authenticator app; Supabase Auth itself demands an aal2 session to remove a verified factor. Audited.",
  "app/(auth)/invite/[token]/actions.ts::acceptInvite":
    "Authorised by the invite token hash; rate-limited per IP.",
  "app/api/jobs/[queue]/route.ts::POST":
    "Authorised by the constant-time JOB_SECRET check; failures are rate-limited.",
  "app/(app)/inbox/ai-actions.ts::aiFeedback":
    "The kb_feedback row is itself the attributed record (user, conversation, rating; no draft text).",
  "app/(app)/inbox/ai-actions.ts::saveConversationSummary":
    "Conversation lifecycle is recorded on the contact timeline; the summary text is health data and stays out of audit_log.",
  "app/api/webhooks/meta/route.ts::POST":
    "Authorised by the X-Hub-Signature-256 HMAC; failures are rate-limited.",
  "app/onboarding/actions.ts::createWorkspace":
    "First-run only: ALLOW_WORKSPACE_CREATION flag, signed-in user, rate-limited.",
  "components/shell/actions.ts::setPresence": "Caller's own membership row.",
  "components/shell/actions.ts::markAllNotificationsRead": "Caller's own notifications.",
  "components/shell/actions.ts::markNotificationRead": "Caller's own notifications.",
  "components/shell/actions.ts::switchOrg":
    "Cookie switch; membership is verified on every request.",
  "app/(app)/notifications/actions.ts::snoozeNotification":
    "Caller's own notification (RLS: user_id = auth.uid()); the preset is validated and the time computed on the server.",
  "app/(app)/notifications/actions.ts::unsnoozeNotification": "Caller's own notification (RLS).",
  "app/(app)/notifications/actions.ts::setNotificationRead": "Caller's own notification (RLS).",
  "app/(app)/notifications/actions.ts::dismissNotification": "Caller's own notification (RLS).",
  "app/(app)/settings/notifications/actions.ts::registerPushSubscription":
    "Caller's own browser. The endpoint must belong to a known push service (SSRF allowlist), the subscription is encrypted at rest, devices per person are capped and the call is rate-limited.",
  "app/(app)/settings/notifications/actions.ts::unregisterPushSubscription":
    "Removes only the caller's own device (org, user and endpoint hash must all match).",
  "app/(app)/settings/notifications/actions.ts::removePushDevice":
    "Removes only the caller's own device (org and user must match the row).",
  "app/(app)/help/actions.ts::submitFeedback":
    "Any signed-in member may send feedback about the app. The row is written with the caller's own id and workspace, the page path has ids stripped, and it is rate-limited (10 per hour).",
  "app/(app)/settings/notifications/actions.ts::sendTestPush":
    "Sends a fixed generic message to the caller's own devices only; rate-limited.",
};

/**
 * Mutating entry points that do not write audit_log. audit_log is reserved for security,
 * configuration, identity, export/delete/merge and auth events. Day-to-day record changes are
 * attributed elsewhere (contact timeline_events with actor, messages.sent_by_user_id, own-data prefs).
 */
export const AUDIT_EXEMPT: Record<string, string> = {
  "app/(app)/contacts/actions.ts::updateContact":
    "Field-level diff with actor goes to the contact timeline.",
  "app/(app)/contacts/actions.ts::addContactPhone":
    "Recorded on the contact timeline (phone.added).",
  "app/(app)/contacts/actions.ts::removeContactPhone":
    "Recorded on the contact timeline (phone.removed).",
  "app/(app)/contacts/actions.ts::makePhonePrimary":
    "Recorded on the contact timeline (phone.primary_changed).",
  "app/(app)/contacts/actions.ts::setContactTags": "Recorded on the contact timeline.",
  "app/(app)/contacts/actions.ts::refreshSegmentCounts": "Derived counts only.",
  "app/(app)/contacts/actions.ts::saveGridPrefs": "Caller's own UI preferences.",
  "app/(app)/portal/actions.ts::savePortalGridPrefs": "Caller's own UI preferences.",
  "app/(app)/inbox/actions.ts::addComment":
    "The comment is itself the attributed record (messages.sent_by_user_id) and mentions.",
  "app/(app)/inbox/actions.ts::retryFailedMessage": "Message row carries the retry; operational.",
  "app/(app)/inbox/actions.ts::markConversationRead": "High-volume operational read marker.",
  "app/(app)/inbox/actions.ts::assignConversation":
    "Conversation lifecycle is recorded on the contact timeline.",
  "app/(app)/inbox/actions.ts::autoAssignConversation":
    "Conversation lifecycle is recorded on the contact timeline.",
  "app/(app)/inbox/actions.ts::setConversationStatus":
    "Conversation lifecycle is recorded on the contact timeline.",
  "app/(app)/inbox/actions.ts::closeConversation":
    "Conversation lifecycle (with category/summary) is recorded on the contact timeline.",
  "app/(app)/inbox/actions.ts::toggleConversationLabel": "Operational labelling.",
  "app/(app)/inbox/actions.ts::setBotActive":
    "Conversation lifecycle is recorded on the contact timeline.",
  "app/(app)/inbox/actions.ts::startConversation": "The queued message carries sent_by_user_id.",
  "app/(app)/inbox/actions.ts::saveInboxView": "Caller's own saved view.",
  "app/(app)/inbox/actions.ts::deleteInboxView": "Caller's own saved view.",
  "app/(app)/inbox/ai-actions.ts::aiFeedback":
    "The kb_feedback row is itself the attributed record (user, conversation, rating; no draft text).",
  "app/(app)/inbox/ai-actions.ts::recordSuggestionOutcome":
    "The ai_suggestion_outcomes row is itself the attributed record (user, suggestion, verdict, similarity; no text from either side).",
  "app/(app)/inbox/ai-actions.ts::saveConversationSummary":
    "Conversation lifecycle is recorded on the contact timeline; the summary text is health data and stays out of audit_log.",
  "app/api/webhooks/meta/route.ts::POST":
    "Raw ingress; the stored webhook_events_in row is the record.",
  "app/api/webhooks/in/[flowId]/route.ts::POST":
    "Ingress; the flow_runs row (with its trigger data) is the record and every step is traced in flow_run_steps.",
  "components/shell/actions.ts::setPresence": "Caller's own presence.",
  "components/shell/actions.ts::markAllNotificationsRead": "Caller's own notifications.",
  "components/shell/actions.ts::markNotificationRead": "Caller's own notifications.",
  "app/(app)/notifications/actions.ts::snoozeNotification":
    "Caller's own notification state (snooze).",
  "app/(app)/notifications/actions.ts::unsnoozeNotification":
    "Caller's own notification state (snooze).",
  "app/(app)/notifications/actions.ts::setNotificationRead":
    "Caller's own notification state (read marker).",
  "app/(app)/notifications/actions.ts::dismissNotification":
    "Caller's own notification; high volume, no content in audit_log.",
  "app/(app)/settings/notifications/actions.ts::savePreferences":
    "Caller's own notification preferences.",
  "app/(app)/settings/notifications/actions.ts::removePushDevice":
    "Caller's own device registration; the push_subscriptions row itself is the record.",
  "app/(app)/front-desk/actions.ts::setCheckin":
    "High-volume desk work (four taps per patient). appointments is a history-tracked table, so record_history names the person, the field and the time of every change (the action writes through createAdminClient(userId)).",
  "app/(app)/help/actions.ts::submitFeedback":
    "The help_feedback row is itself the attributed record (user, page, time); administrators triage it.",
  "app/(app)/front-desk/actions.ts::addHandoverNote":
    "The note is itself the attributed record (created_by, created_at); it carries no audit-worthy configuration.",
  "app/(app)/front-desk/actions.ts::resolveHandoverNote":
    "The note records who resolved it and when (resolved_by, resolved_at).",
  "app/(app)/media/actions.ts::prepareLibraryUpload":
    "Only creates a 'pending' row that nobody can see or use. finalizeLibraryUpload audits the upload (media.uploaded), a rejected check audits media.upload_rejected, an abandoned one media.upload_cancelled, and the nightly task removes the rest.",
  "app/(app)/contacts/documents/actions.ts::prepareDocumentUpload":
    "Only creates a 'pending' row that nobody can see or open. finalizeDocumentUpload audits the upload (document.uploaded), a rejected check audits document.upload_rejected, an abandoned one document.upload_cancelled, and the nightly task removes the rest.",
};

/** Modules allowed to read channel_secrets (they decrypt or store the Meta token). */
export const CHANNEL_SECRET_MODULES = new Set([
  "lib/whatsapp/channel.ts",
  "app/(app)/settings/channels/page.tsx", // selects channel_id only, to show "stored on channel"
  "scripts/cutover-preflight.ts", // selects channel_id only, to report whether a token exists
]);
