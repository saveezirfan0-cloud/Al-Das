# Finance access window: notes

Closes the `docs/09` §2.3 Security gap "working-hours or IP restriction for finance". Built in a cloud sandbox with plain Postgres; type-checked, linted and unit-tested, not driven in a browser or behind Vercel.

Migration `supabase/migrations/20261121000100_finance_access_window.sql`; paste file `deploy/supabase-paste/61_finance_access_window.sql` (same SQL). The migration only adds the alert kind `finance_access_denied` to `security_alerts`; the setting itself is `orgs.settings->'finance_access'` (no new table).

## What exists

| Part | Where | What it does |
|---|---|---|
| Setting | `lib/security/finance-access.ts` (`financeAccessSchema`, `readFinanceAccess`, `writeFinanceAccess`) | `enabled` (default **false**), `limit_hours`, `days` (ISO 1 = Monday ... 7 = Sunday, default Monday to Saturday), `start` / `end` (HH:MM in the org timezone, `orgs.timezone`; default 07:00 to 21:00), `ip_allowlist` (IPv4/IPv6 addresses and CIDR ranges, max 50, stored canonical with host bits cleared, `/0` refused), `scope` (`finance_roles` = every role holding any `finance.*` / `accounting.*` key, or `selected_roles` with `role_ids`) |
| Decision | `financeAccessDecision({ now, timezone, stored, ip, member })` (pure) | Order: Admin (`*`) allowed; a role without finance/accounting keys allowed; an unreadable stored value **denied** (`invalid_settings`); switched off allowed; role not in scope allowed; address list set and no address **denied** (`ip_unknown`) or not on it **denied** (`ip_not_allowed`); days/hours checked (`day_not_allowed`, `outside_hours`; an invalid timezone denies). Start is inclusive, end exclusive; start > end is an overnight window that belongs to the day it opens; start = end is the whole day |
| Client address | `lib/security/client-ip.ts` | `rawClientIp` (header order `x-vercel-forwarded-for`, `x-real-ip`, first hop of `x-forwarded-for`; `lib/rate-limit.ts` `clientIp` now uses it), `parseClientIp` (strips `[v6]:port` and `v4:port`, refuses anything that is not an address), `parseIpRange`, `ipInRange`, `ipAllowed` (IPv4-mapped IPv6 matches IPv4 ranges), `ipNetworkLabel` (/24 or /48 for alerts). Pure, no Node built-ins |
| Enforcement | `lib/auth/session.ts` `getCurrentMember()` + `lib/auth/can.ts` | The decision is made once per request from the org row the membership query already loads (no extra query). When it denies, the member gets `restrictedAreas = ["finance", "accounting"]` and `can()` returns false for any key in those areas; every other permission is unchanged. So every existing gate refuses without edits: `requirePerm`, the module `gate()` helpers in `app/(app)/finance/**/actions.ts` and `app/(app)/accounting/**/actions.ts`, route handlers under `app/api/finance` and `app/api/accounting` (403), the menu (`buildNavTree`), finance badges |
| Page navigations | `requirePerm` (`blockedByFinanceWindow`, `refuseOutsideFinanceWindow`), `enforceFinanceWindow` in `app/(app)/finance/layout.tsx`, `app/(app)/accounting/layout.tsx` and both index pages | A page refused by the window redirects to `/finance-unavailable` (`app/(app)/finance-unavailable/page.tsx`): the reason, when finance is open, "approved locations only" when a list is set, and for an address problem the person's own address so IT can add it. A server action refused by `requirePerm` gets the usual `ForbiddenError`; `gate()`-based actions return their usual "not allowed" result |
| Recording | `lib/security/finance-access-server.ts` `noteFinanceDenial`, `financeAccessAlert` | One `security_alerts` row per member per local day (`finance_access:<user>:<yyyy-mm-dd>`), kind `finance_access_denied`, detail: reason, local day, the /24 (IPv6 /48) network and the keyed HMAC of the address (`hashValue`, as in the login history). Never the full address. Raised when a refusal happens on a finance or accounting path (pages, their server actions, `/api/finance`, `/api/accounting`; the middleware forwards the path in `x-pulse-path`, overwritten on every request), and from `requirePerm` anywhere else. Admins with `settings.manage` are notified by `raiseAlert` |
| Settings screen | `app/(app)/settings/security/finance-window-form.tsx`, `saveFinanceAccessWindow` in `actions.ts` | Under Settings, Security (`security.manage`). Shows whether the person saving is inside the address list. The action validates with the same schema, checks the chosen roles belong to the org, writes `orgs.settings.finance_access` (other keys kept) and records `finance_access_window.updated` with the changed keys, days, hours, scope and **counts** (address entries, roles), never the addresses |

## Decisions

1. **Admin is never restricted.** Any role holding `*` bypasses the window, whatever is stored, so nobody can lock the clinic out of fixing it. Admin roles cannot be ticked in "Only these roles".
2. **Fail closed where it matters.** A stored value that does not validate (only possible by editing the database) closes finance for every finance role until an Admin saves it again; the Settings screen says so. A missing or unparseable client address is refused only when an address list is set.
3. **No middleware query.** The window is decided in `getCurrentMember()` from the org row it already loads, so the middleware stays query-free and nothing changes while the window is off. The middleware only forwards the path header.
4. **Only finance and accounting keys are taken away.** A receptionist who holds `finance.cashup` loses cash-ups outside the window and keeps the inbox, appointments and everything else.
5. **Address privacy.** The alert keeps the network and a keyed hash; the full address is shown only to the person themselves on the refusal page and to the person saving the settings (their own address).
6. **Header trust.** On Vercel the edge sets the forwarding headers and overwrites client values. Behind another proxy, an address list is only as trustworthy as that proxy; this is documented in `client-ip.ts`.
7. **Jobs and service-role code are unaffected:** they do not go through `getCurrentMember()`.

## Known limits

- **Direct database reads with the member's own token are not blocked by the window.** Row level security still applies the role's permissions, so a finance member who calls the Supabase REST API directly from the browser outside the window can read what their role can read. Closing that needs the time check inside `app.has_perm` (the address is not reliably available to Postgres); not built.
- Outside the window Finance and Accounting disappear from the menu for the covered roles; typing a finance address shows the explanation page.
- Someone already on a finance page when the window closes sees their next action refused with the normal "not allowed" message; the next navigation shows the explanation page.
- React's `cache()` does not memoise in every server context, so a refused request can attempt the alert more than once; the unique dedupe key keeps it to one alert (and one notification) per member per day.
- Not exercised against a real Vercel deployment or Supabase project.

## Tests

- `tests/unit/security-client-ip.test.ts`: header order, garbage headers, IPv4/IPv6 parsing (compression, embedded IPv4, mapped IPv4, ports, brackets, zones refused), canonical ranges, CIDR boundaries v4/v6, cross-version, network labels.
- `tests/unit/security-finance-access.test.ts`: schema defaults and validation, read/write keeps other settings, unreadable setting fails closed, Admin bypass, scope, hour boundaries, closed days, DST (Europe/London both changes), overnight windows, whole-day windows, address lists v4/v6 and missing address, `can()` with restricted areas.
- `tests/unit/security-finance-access-session.test.ts`: the session wiring (off changes nothing, refused member loses finance/accounting only, refusal recorded on finance and API paths and not on others, Admin bypass, page redirect vs action `ForbiddenError`, a permission the role never had stays a normal `ForbiddenError`).
- `tests/unit/security-finance-access-server.test.ts`: alert contents (no full address), per-day dedupe key, never throws.
- `tests/unit/security-middleware-mfa.test.ts`: the path header is forwarded and overwrites a browser value.
- `tests/db/finance-access-window.test.ts`: the new alert kind is accepted and deduped, unknown kinds still refused, visible to the org's own admin only, not writable by signed-in users.
