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
  "app/(auth)/invite/[token]/actions.ts::acceptInvite":
    "Authorised by the invite token hash; rate-limited per IP.",
  "app/api/jobs/[queue]/route.ts::POST":
    "Authorised by the constant-time JOB_SECRET check; failures are rate-limited.",
  "app/api/webhooks/meta/route.ts::POST":
    "Authorised by the X-Hub-Signature-256 HMAC; failures are rate-limited.",
  "app/onboarding/actions.ts::createWorkspace":
    "First-run only: ALLOW_WORKSPACE_CREATION flag, signed-in user, rate-limited.",
  "components/shell/actions.ts::setPresence": "Caller's own membership row.",
  "components/shell/actions.ts::markAllNotificationsRead": "Caller's own notifications.",
  "components/shell/actions.ts::markNotificationRead": "Caller's own notifications.",
  "components/shell/actions.ts::switchOrg":
    "Cookie switch; membership is verified on every request.",
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
  "app/api/webhooks/meta/route.ts::POST":
    "Raw ingress; the stored webhook_events_in row is the record.",
  "components/shell/actions.ts::setPresence": "Caller's own presence.",
  "components/shell/actions.ts::markAllNotificationsRead": "Caller's own notifications.",
  "components/shell/actions.ts::markNotificationRead": "Caller's own notifications.",
};

/** Modules allowed to read channel_secrets (they decrypt or store the Meta token). */
export const CHANNEL_SECRET_MODULES = new Set([
  "lib/whatsapp/channel.ts",
  "app/(app)/settings/channels/page.tsx", // selects channel_id only, to show "stored on channel"
  "scripts/cutover-preflight.ts", // selects channel_id only, to report whether a token exists
]);
