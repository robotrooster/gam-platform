# Session 168 — closed

## Theme

Manager Connect opt-in path — closes the S167 manager-fee Transfer
loop. CLAUDE.md spec (locked: "managers get a Connect account only
when their landlord enables direct deposit, per-manager opt-in,
default off") is now implemented end-to-end.

## What S168 shipped

### Schema

- **Migration `20260507000000_pm_scopes_direct_deposit.sql`** —
  adds `property_manager_scopes.direct_deposit_enabled boolean
  NOT NULL DEFAULT false`. Per-scope-row (not per-user) so a
  manager scoped to multiple landlords gets one toggle per
  employer. No backfill needed.

### API

- **`apps/api/src/routes/scopes.ts`**
  - `GET /scopes/team` — property_manager rows now expose
    `direct_deposit_enabled` plus the cached Connect readiness
    flags (`connect_charges_enabled` / `connect_payouts_enabled`
    / `connect_details_submitted`) from the joined users row, so
    TeamPage can render toggle state + onboarding progress in
    one round-trip.
  - **NEW** `PATCH /scopes/property_manager/:userId/direct-deposit`
    — landlord-only toggle endpoint. Body `{ enabled: boolean }`.
    On a genuine false→true transition, fires
    `createNotification` to the manager (in-app + email) telling
    them to onboard via Banking. Idempotent re-enables don't
    re-notify (snapshots the prior state before update).

- **`apps/api/src/routes/auth.ts`** — `getScopeForUser` for
  property_manager now selects `direct_deposit_enabled` and
  returns it as `directDepositEnabled` on the result. Login
  response (`/auth/login`) and `/auth/me` both surface it on
  `data.user.directDepositEnabled`. Frontend reads from
  AuthContext.

### Frontend (landlord portal)

- **`apps/landlord/src/pages/TeamPage.tsx`**
  - New `Member` fields: `direct_deposit_enabled`,
    `connect_charges_enabled`, `connect_payouts_enabled`,
    `connect_details_submitted`.
  - New `toggleDirectDeposit` mutation hitting the new PATCH route.
  - Expanded property_manager rows render a `DirectDepositToggle`
    above the existing sub-permissions grid: checkbox + status
    pill (Disabled / Awaiting onboarding / Verifying / Connected)
    + helper copy. Toggle-on shows a confirm() dialog because of
    the email/notification side effect.
  - New summary KPI card surfaces above the invitations table:
    "N manager(s) have direct deposit enabled but haven't
    completed Stripe Connect onboarding yet" — only renders when
    that count > 0.

- **`apps/landlord/src/components/layout/Layout.tsx`**
  - `/banking` nav item `roles` widened from `['landlord']` to
    `['landlord','property_manager']`.
  - Visibility filter special-cases `/banking` for
    `role === 'property_manager'`: only renders when
    `user.directDepositEnabled === true`. Without the toggle
    on, managers don't see Banking in the sidebar.

- **`apps/landlord/src/pages/BankingPage.tsx`**
  - Added `useAuth` import; computed `isManager = user?.role === 'property_manager'`.
  - Manager render path: page header + intro copy explaining the
    landlord enabled direct deposit, then the existing
    `<StripeConnectSection />`. Bank-accounts query is gated to
    `enabled: !isManager` so the legacy 16a catalog endpoint
    never fires for manager callers.
  - Landlord render path is unchanged.

### Notification

The new `manager_direct_deposit_enabled` notification type is
emitted when a landlord flips the toggle on. Uses the existing
`createNotification` service — in-app row + email via the central
send helper (so `email_send_log` captures delivery just like
every other email). No new notification preference seed; the
notifications service silently allows new types to default to
"in_app: on, email: on, sms: off" via the prefs lookup fallback.

The `data` payload includes `landlordId` and a `portalUrl` deep
link to `/banking` for the email's CTA.

### Verification

- `cd apps/api && npx tsc --noEmit` exit 0
- `cd apps/landlord && npx tsc --noEmit` exit 0
- `psql gam -c "\d property_manager_scopes"` confirms
  `direct_deposit_enabled | boolean | not null | false`
- `schema_migrations` has the new row at the top.

## Files touched

```
apps/api/src/db/migrations/20260507000000_pm_scopes_direct_deposit.sql  NEW
apps/api/src/db/schema.sql                                              regenerated
apps/api/src/routes/scopes.ts                                           (+ PATCH direct-deposit endpoint, + team payload fields, + notifications import)
apps/api/src/routes/auth.ts                                             (getScopeForUser returns directDepositEnabled; login + /me surface it)
apps/landlord/src/pages/TeamPage.tsx                                    (per-row toggle + summary KPI + DirectDepositToggle component)
apps/landlord/src/components/layout/Layout.tsx                          (/banking widened to property_manager + visibility special-case)
apps/landlord/src/pages/BankingPage.tsx                                 (manager render path; legacy catalog hidden for managers)
```

## Decisions made (S168)

| Question | Decision |
|---|---|
| Toggle ownership | Landlord-controlled per-scope toggle on `property_manager_scopes` (CLAUDE.md spec). Confirmed S168. |
| Roles in scope | property_manager only this session. onsite_manager / maintenance / bookkeeper don't earn `allocation_manager_fee` so they don't need Connect. The endpoint + UI are role-targeted, easy to widen later. |
| Notification path | In-app + email via `createNotification('manager_direct_deposit_enabled', ...)`. No SMS (default for new types). Email CTA deep-links to `/banking`. |
| Stale-skip detection | Deferred — `managerTransferReconciliation.ts` already retries daily and the new TeamPage KPI surfaces the count visually to the landlord. A "manager opted in 30+ days ago, still not Connect-ready" admin notification can layer on later if the visual surface isn't enough. |

## Carry-forward — what S169 should target

S167 carry-forward minus the manager opt-in (now done):

### Legacy disbursements queue cleanup

`services/disbursementFiring.ts` was deleted in S167 but the
retry surface in `routes/withdrawals.ts` and the admin retry
endpoint at `routes/admin.ts:445` still drain pre-S167 rows. The
GAM-rail queue is empty pre-launch; both surfaces can be deleted.
Small cleanup session.

### Stale doc comment in `apps/api/src/lib/stripe.ts:51-57`

The "Connect helpers removed" comment is misleading post-S113.
One-line fix when next touching that file.

### E — `apps/admin/src/main.tsx` split

~1700 lines, ~16 inline page functions. Mechanical refactor.
Skipped in S167 per Nic. Pure cleanup whenever that file is
next touched for a real change.

### `lease_fees.due_timing` `move_out` / `other` wiring

S167 phase B wired these for the deposit-deduction path
(`services/depositReturn.ts` + `processLeaseEnds` auto-creates
the deposit-return draft on natural expiry). Considered closed.
The S167 carry-forward note that re-listed this was stale.

### Forward-looking items not yet on the carry-forward list

- **Stripe-Custom-controller migration** — Nic dislikes Stripe
  being visible (`stripe_dashboard.type='express'` shows the
  Stripe-branded onboarding component). A Custom-controller
  migration removes the brand visibility but increases GAM's
  KYC/UX build burden. Tracked future item.
- **Manager Connect onboarding status visibility on the landlord
  side** — landlord can see direct_deposit_enabled state and the
  KPI count; they can't drill into a specific manager to see
  which Stripe requirements are still outstanding. If product
  wants that, a `GET /scopes/property_manager/:userId/connect-status`
  proxy through the Stripe API is a straightforward add.

## Manual verification

1. Landlord login → /team page → expand a property_manager row.
   Verify:
   - "Direct Deposit" toggle renders above the sub-permissions grid
   - Status pill says "Disabled" by default
2. Toggle on → confirm dialog → click OK. Verify:
   - Toggle pill flips to "Awaiting onboarding"
   - The manager's user row receives a new `notifications` entry
     of type `manager_direct_deposit_enabled`
   - `email_send_log` shows a row for that notification type
3. Manager logs into the landlord portal (port 3001):
   - Banking link is now visible in the left nav
   - /banking page renders ONLY the StripeConnectSection (no
     "Add Bank Account" header, no legacy 16a catalog)
   - Onboarding flow can be initiated; Stripe-hosted KYC
     completes inside GAM's URL via the embedded component
4. Once Stripe webhooks fire `account.updated` with charges + payouts
   enabled, the manager's `users.connect_charges_enabled` etc. flip
   true (existing S167 wiring). On the landlord's TeamPage, the
   manager's status pill flips from "Verifying" to "Connected" and
   the summary KPI card disappears.
5. Next allocation_manager_fee row written for that manager will
   fire a Stripe Transfer to their Connect account on the post-commit
   firing path (already wired in S167 Phase 1).

---

## Bonus — Books frontend AZ rename + label strip

After the manager Connect opt-in shipped, picked an additional
DEFERRED.md item: closing the S91 STILL-OUTSTANDING frontend
rename for `apps/books/src/main.tsx`. Backend portion shipped at
S91; frontend has been carrying the AZ vocabulary and a 2.5
default since.

### Shipped

- **`apps/books/src/main.tsx`**:
  - Form field `azWithholdingPct` → `stateWithholdingPct`
    (initForm, POST body, input value + change handler).
  - Default prefill **`'2.5'` → `'0'`** to align with the
    backend `state_withholding_pct DEFAULT 0` (S91). The 2.5
    prefill was a silent "AZ default" leaking into every
    landlord's new-employee form regardless of state.
  - Form input label "AZ Withholding %" → "State Withholding %".
  - 8 AZ-prefixed display labels rewritten:
    - "YTD AZ State W/H" → "YTD State W/H"
    - KPI subtitle "AZ flat 2.5%" → "Per-employee flat %"
    - "Fed + AZ + SS + Medicare" (×2) → "Fed + State + SS + Medicare"
    - "AZ State W/H (employee 2.5%)" → "State W/H (per-employee flat %)"
    - "AZ State (flat) — 2.5% per employee setting" →
      "State (flat) — Per-employee setting"
    - 3 column headers "AZ State" → "State"
    - "AZ State Tax" → "State Tax"
  - Routes: ComingSoon "AZ state forms" → "state-specific forms".

- **DEFERRED.md** — STILL OUTSTANDING bullet for the frontend
  rename removed (S91 backend + S168 frontend together close
  that line item).

### Verification

- `cd apps/books && npx tsc --noEmit` exit 0.
- `grep -in "azWithholding\|az_withholding\| AZ \|AZ State\|AZ flat\|Arizona" apps/books/src/main.tsx` returns zero matches.

### Files touched (bonus)

```
apps/books/src/main.tsx                                                 (8 AZ-prefix label strips + azWithholdingPct → stateWithholdingPct rename + 2.5 → 0 default)
DEFERRED.md                                                             (− frontend rename bullet under #3 STILL OUTSTANDING)
```

---

## Bonus 2 — Email-failure surface to landlord UI

The `GET /landlords/me/email-failures` endpoint shipped in S101
but never had a UI consumer. Built that surface.

### Shipped

- **`apps/landlord/src/pages/NotificationPrefsPage.tsx`**:
  - Added `useAuth` + an `EmailFailureRow` interface.
  - New `EmailFailuresCard` rendered below the existing prefs
    table, gated to `user?.role === 'landlord'` (the endpoint is
    `requireLandlord`; PMs don't see it). Fetches
    `/landlords/me/email-failures?since_days=30&limit=50` with a
    1-min stale time.
  - Empty state when there are no failures (most landlords most
    of the time). Failure table shows: when, to, subject,
    category, reason — with the error message in red.
  - "Showing latest 50" footer note appears when the result set
    hits the limit.
- **DEFERRED.md** — "Email-failure surface to landlord UI" line
  removed under "Smaller tracked items".

### Coverage caveat carried forward

Per services/email.ts, most senders thread `ctx.landlordId`
(emailNewBackgroundCheck, emailMaintenanceCreated,
emailSigningRequest, emailInvitation, etc.). Senders that don't
thread it land in `email_send_log` with `landlord_id = NULL` and
won't appear on this card. The S131 endpoint comment claiming
"currently: emailTenantOnboarded" is stale — coverage is broad
but not 100%. A future audit pass can retrofit any remaining
unscoped senders. Not blocking this UI surface — for the senders
that do thread, the card works correctly today.

### Files touched (bonus 2)

```
apps/landlord/src/pages/NotificationPrefsPage.tsx                       (+ EmailFailuresCard component, role-gated to landlord)
DEFERRED.md                                                             (− "Email-failure surface to landlord UI" line)
```

---

## Bonus 3 — Manager Connect onboarding drilldown

S168 main ship surfaces a per-manager status pill (Disabled /
Awaiting onboarding / Verifying / Connected) but doesn't tell
the landlord WHY a manager is stuck on Verifying or Awaiting.
This bonus closes that loop: when a landlord clicks "View
requirements" on a stuck row, GAM proxies Stripe's account state
back so the landlord can see the exact KYC items the manager
hasn't filled in.

### Shipped

- **`apps/api/src/routes/scopes.ts`** — new `GET
  /scopes/property_manager/:userId/connect-status` endpoint.
  Auth: `requirePerm('team.manage_permissions')`. Verifies
  scope row exists under the caller's landlord_id (404
  otherwise), looks up `users.stripe_connect_account_id`, and
  if present calls the existing
  `services/stripeConnect.fetchAccountStatus()` helper to pull
  charges_enabled / payouts_enabled / details_submitted /
  requirements_currently_due / requirements_past_due /
  requirements_disabled_reason. Stripe errors propagate to
  the AppError handler.
  Returns `{ exists: false }` when the manager hasn't started
  onboarding (no Connect account yet).

- **`apps/landlord/src/pages/TeamPage.tsx`**:
  - DirectDepositToggle gained a "View requirements" button
    that renders only when `enabled && !ready` (i.e., on the
    Verifying / Awaiting onboarding states).
  - New `ConnectRequirementsModal` component fetches the new
    endpoint on mount and renders a clean breakdown:
    - Disabled-reason callout (red) when Stripe has parked the
      account.
    - Past due requirements (red list).
    - Currently due requirements (gold list).
    - Empty state when verification is in flight with no
      pending items.
    - "Hasn't started" state when `exists: false`.
  - Helper `RequirementsList` component for the two list shapes.

### Coverage details

- Requirements come from Stripe verbatim
  (`requirements.currently_due`, `requirements.past_due`,
  `requirements.disabled_reason`) — no GAM mapping. Items look
  like `individual.id_number`, `external_account`,
  `tos_acceptance.date`, etc. Showing the raw Stripe ids is
  acceptable here: this audience is the landlord forwarding the
  list to their manager, who'll see the same labels in the
  Stripe-hosted onboarding UI.
- The endpoint is landlord-scoped via existing scope-row
  authorization. Caller can only inspect managers under their
  own landlord_id.

### Verification

- `cd apps/api && npx tsc --noEmit` exit 0.
- `cd apps/landlord && npx tsc --noEmit` exit 0.

### Files touched (bonus 3)

```
apps/api/src/routes/scopes.ts                                           (+ GET /property_manager/:userId/connect-status)
apps/landlord/src/pages/TeamPage.tsx                                    (+ ConnectRequirementsModal + RequirementsList + View requirements button)
```

---

## Bonus 5 — Email-failure coverage audit + dead-sender cleanup

The S101 endpoint comment claimed coverage was narrow ("currently:
emailTenantOnboarded"). Audited every active call site of every
`email*`/`send*` function across api/src; result: every active
sender threads `ctx.landlordId`. Coverage was already broad
post-S106; the stale comment under-sold the surface that the
bonus 2 EmailFailuresCard now exposes.

### Shipped

- **`apps/api/src/services/email.ts`** — deleted three orphan
  senders that have zero callers anywhere in the codebase:
  - `emailMaintenanceCreated` (replaced by createNotification
    flow under the S106 generic notification email path).
  - `sendDisbursementConfirmation` (S113 destination charges
    superseded the GAM-rail disbursement model; no consumer).
  - `sendAchReturnAlert` (no consumer; ACH-return alerting
    flows through admin notifications now).

- **`apps/api/src/routes/landlords.ts`** — refreshed the stale
  S101 endpoint comment to reflect the post-S168 reality:
  coverage is broad, not narrow. Future senders only need to
  thread `ctx.landlordId` to be picked up automatically.

### Verification

- `cd apps/api && npx tsc --noEmit` exit 0.
- `grep -rn emailMaintenanceCreated|sendDisbursementConfirmation|sendAchReturnAlert apps`
  returns zero matches outside the deleted lines.
- Audit trail of caller threading (every entry passes
  `ctx.landlordId` correctly):
  ```
  jobs/leaseParser/resolveIntent.ts:325  emailTenantOnboarded
  jobs/scheduler.ts:297                  emailSigningReminder
  jobs/scheduler.ts:333                  emailDocumentAutoVoided
  jobs/scheduler.ts:871                  sendLatePaymentNotice
  jobs/scheduler.ts:897                  sendOnTimePayInvitation
  routes/tenants.ts:112                  emailLandlordBankingNudge
  routes/scopes.ts:404,531               emailInvitation
  routes/background.ts:373               emailNewBackgroundCheck
  routes/background.ts:491               emailBackgroundDecision
  routes/background.ts:526               emailAdverseActionNotice
  routes/background.ts:860               emailPoolMatchInterest
  routes/background.ts:900               emailPoolTenantInterested
  routes/landlords.ts:652,1792           emailTenantOnboarded
  routes/landlords.ts:2288               emailPmPropertyInvitation
  routes/pm.ts:823                       emailPmPropertyInvitation
  routes/esign.ts:1806,2128              emailSigningRequest
  routes/esign.ts:2104                   emailSigningCompleted
  ```
  emailPmInvitation (pm.ts:462,507) intentionally passes
  `landlordId: null` — pm_invitations are scoped to the
  pm_company, not a landlord. That's correct posture.

### Files touched (bonus 5)

```
apps/api/src/services/email.ts                                          (− 3 orphan senders: emailMaintenanceCreated, sendDisbursementConfirmation, sendAchReturnAlert)
apps/api/src/routes/landlords.ts                                        (refresh stale S101 endpoint comment)
```

---

## Bonus 4 — DEFERRED.md cleanup: stale S26a line

S26a catch-up window admin endpoint
(`POST /admin/invoices/backfill`) already exists at
`apps/api/src/routes/admin.ts:504` with full from / to /
landlord_id / lease_id / dry_run shape, super_admin gated, with
admin_action_log writes. The DEFERRED bullet under "Smaller
tracked items" was stale — endpoint shipped before this session.
Line removed. (No UI consumer exists today; if Nic wants a
backfill UI on the admin portal, it's a small follow-on, but the
core endpoint is curl-ready right now.)

```
DEFERRED.md                                                             (− "S26a catch-up window admin endpoint" line)
```
