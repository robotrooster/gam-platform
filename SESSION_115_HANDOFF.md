# Session 115 Handoff

**Theme:** Stripe Connect rebuild — Session 2. Service layer + routes
for creating Connect Express accounts and the embedded
`<ConnectAccountOnboarding />` component's Account Session token.
Webhook handler for `account.updated` so GAM tracks KYC progress.

Schema migration in S114 made the columns; S115 makes them usable.
Frontend mounting of the embedded component is its own session.

## Architecture decisions

**Modern controller-based Stripe API.** Per the email Darby sent:
"Dashboard: express, Fee collection: application, Loss responsibility:
application." Translated to Stripe's current API:

```js
stripe.accounts.create({
  controller: {
    stripe_dashboard: { type: 'express' },
    fees:             { payer: 'application' },
    losses:           { payments: 'application' },
  },
  capabilities: {
    card_payments: { requested: true },
    transfers:     { requested: true },
  },
  ...
})
```

This is the future-proof shape; the deprecated `type: 'express'`
parameter is avoided.

**`ensureConnectAccount` is idempotent.** Re-onboarding (caller comes
back to the onboarding flow before KYC is complete) reuses the
existing Connect account id; it does NOT create a duplicate. Both
SQL persists (`UPDATE … WHERE stripe_connect_account_id IS NULL`)
guard against accidental overwrite.

**Two entity classes through one route.** The onboarding-session
route accepts `entity: 'user' | 'pm_company'`. For 'user', the caller
is onboarding their own Connect account (landlord or future opt-in
manager). For 'pm_company', the caller must be `role='owner'`,
`status='active'` on `pm_staff` for that company. One code path
covers both with the entity discriminator.

**Account Sessions are per-render.** Stripe's Account Session tokens
are short-lived (a few minutes). The route returns a fresh token
each call; the frontend re-fetches every time the embedded component
mounts. No caching, no DB persistence of the session token.

**`account.updated` records timestamp only.** The webhook handler
snapshots `stripe_connect_status_synced_at` on the matching entity
row but doesn't persist the capability flags or requirement lists.
Reasoning: those are read live from Stripe via `fetchAccountStatus`
when the dashboard loads (one extra HTTP call per page; negligible).
Storing them locally would require keeping two sources of truth in
sync. The synced_at timestamp is just a liveness signal.

**Cross-platform Stripe events are silent no-ops.** A Stripe webhook
for an account that doesn't match any GAM Connect id `UPDATE`s zero
rows. Defensive against misconfigured webhook endpoints receiving
events for other Stripe platforms.

## Shipped

### Migration `20260504050000_stripe_connect_status_synced.sql`

Adds `stripe_connect_status_synced_at timestamptz` to both `users`
and `pm_companies`. Nullable; populated by the `account.updated`
webhook.

### apps/api/src/services/stripeConnect.ts (new)

Exports:
- `ensureConnectAccount(opts)` — creates a Connect account if one
  doesn't already exist for the entity, persists the id back to GAM.
  Idempotent. Calls `stripe.accounts.create` with the controller
  config from the locked architecture.
- `createOnboardingSession(connectAccountId)` — creates a Stripe
  Account Session enabling `account_onboarding`, returns the
  `client_secret` for the frontend to render the embedded component.
- `fetchAccountStatus(connectAccountId)` — reads `charges_enabled`,
  `payouts_enabled`, `details_submitted`, requirements lists, and
  any `disabled_reason` directly from Stripe.
- `recordAccountUpdated(account)` — webhook handler hook that
  snapshots `synced_at` on the matching entity. Cross-platform-safe.

### apps/api/src/routes/stripe.ts

Two new endpoints (both `requireAuth`):

- `POST /api/stripe/connect/onboarding-session`
  Body: `{ entity: 'user' | 'pm_company', entityId?: string }`.
  For `'user'`: onboards the caller's own Connect account using
  their email. For `'pm_company'`: caller must be active owner;
  uses pm_company.business_email or falls back to caller email.
  Returns `{ connectAccountId, clientSecret }` for the frontend.
- `GET /api/stripe/connect/status?entity=user|pm_company&entityId=<uuid?>`
  Returns the live Connect account state from Stripe. `exists: false`
  when the entity has no Connect id yet (frontend should kick off
  the onboarding flow). Otherwise returns `{ connectAccountId,
  exists: true, charges_enabled, payouts_enabled, details_submitted,
  requirements_currently_due[], requirements_past_due[],
  requirements_disabled_reason }`.

The S67 deletion comment that said "Connect-flavored landlord
onboarding routes deleted" was retained but corrected — the comment
now explains that Connect IS the rail under S113 and the new routes
above replace what was deleted.

### apps/api/src/routes/webhooks.ts

New `case 'account.updated'` calls `recordAccountUpdated`. Returns
500 (Stripe retries with backoff) if the SQL UPDATE fails. Defensive
no-op for unknown account ids (UPDATEs zero rows).

## Files touched

- `apps/api/src/db/migrations/20260504050000_stripe_connect_status_synced.sql` (new)
- `apps/api/src/db/schema.sql` (regenerated, 8144 → 8146 lines)
- `apps/api/src/services/stripeConnect.ts` (new — 4 exported helpers)
- `apps/api/src/routes/stripe.ts` (2 new endpoints + obsolete comment correction)
- `apps/api/src/routes/webhooks.ts` (account.updated handler)
- `SESSION_115_HANDOFF.md` (this file)

## Validation

- `npm run db:migrate` → 1 applied; schema.sql regenerated to 8146 lines
- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- 8-step SQL-path smoke against dev DB:
  1. Pre-create state: `users.stripe_connect_account_id = null` ✓
  2. Persist a synthetic Stripe acct id ✓
  3. Idempotency: second persist with different id is no-op
     (existing id preserved) ✓
  4. `pm_company` ownership check (matching the route's role/status
     gate) ✓
  5. Persist Connect id on pm_company ✓
  6. `account.updated` SQL: `synced_at` populated ✓
  7. Unknown account event = silent no-op ✓
  8. Partial UNIQUE on `stripe_connect_account_id` rejects two users
     sharing one Stripe account id ✓

## What this session did NOT do (and what remains in the rebuild plan)

- **No live Stripe API calls.** Smoke verified the SQL paths and
  webhook handler shape. The actual `stripe.accounts.create`,
  `stripe.accountSessions.create`, and `stripe.accounts.retrieve`
  calls require a live `STRIPE_SECRET_KEY` to test. First end-to-end
  exercise will be in the Stripe sandbox after the contract is
  signed (May 18 deadline).
- **No frontend.** The frontend mounts the embedded
  `<ConnectAccountOnboarding />` component using Stripe's
  `connect-js` SDK; it consumes the `clientSecret` returned by the
  POST endpoint. Frontend session lands separately.
- **S116 — destination charge wiring + allocation engine refactor.**
  The current allocation engine writes to `user_balance_ledger`
  after the fact. S116 rewires it to compute `application_fee_amount`
  at PaymentIntent creation time and pass `transfer_data.destination`,
  letting Stripe split at charge. Most of the existing engine logic
  (banking_fee_payer reads, manager fee, PM cuts) gets restructured;
  some becomes unused.
- **S117 — additional webhook handlers.** Beyond `account.updated`,
  Connect emits `payout.created`, `payout.failed`, `charge.dispute.created`,
  etc. that GAM should track. Schema additions likely needed for a
  `connect_payouts` log + a `connect_disputes` log.
- **S118 — GAM-native dashboard.** Replace any temptation to embed
  `<ConnectPayouts />` / `<ConnectAccountManagement />` with custom
  GAM UI that calls Stripe APIs directly (per S113 minimal-third-party
  philosophy). Backend routes for that land in S118.
- **S119 — PM Companies money-flow refactor.** S107–S112 wrote PM
  fee math against the legacy ledger model. Under destination charges,
  the PM cut becomes a Stripe `Transfer` between Connect accounts (or
  a multi-destination split at charge time). Schema/routes survive;
  the implementation layer needs rewriting.
- **S120 — Per-occupied-unit platform fee accrual cron.** Schema is
  ready (`platform_fee_accruals` from S114). The cron walks landlords
  monthly, computes long_term + short_stay aggregation per the locked
  RV/STR rule, posts to the accrual table. May charge tenant or
  landlord depending on `platform_fee_payer`.

## Pre-launch blockers still open

Same as S114:
- ~~Item 16 batch 2~~ — closed
- Item 16 batch 3+ (OTP under Connect) — gated on S116+ landing
- Item 10 (utility billing payment) — composes with S116 destination
  charges naturally
- Plus S116–S120 of the rebuild plan

## What next session (S116) targets

Allocation engine + destination-charge wiring. Concretely:

1. New helpers in `services/stripeConnect.ts` for charge creation:
   - `createDestinationCharge(opts)` — wraps `stripe.paymentIntents.create`
     with `transfer_data.destination` set to the recipient's Connect
     account and `application_fee_amount` set to GAM's cut
2. Refactor `services/allocation.ts`:
   - Replace `banking_fee_payer` reads with the three new toggles
     (S114: `ach_fee_payer`, `card_fee_payer`, `platform_fee_payer`)
   - Compute `application_fee_amount` at charge time from the
     processing rate + the fee toggle (tenant pass-through adds it
     on top; landlord absorb deducts from gross before transfer)
   - Stop writing `user_balance_ledger` rows for
     `allocation_owner_share` (Stripe destination handles this);
     keep manager_fee path for the in-house manager case
   - Wire PM company cut as a separate `Transfer` from landlord's
     Connect to PM company's Connect after the destination charge
     settles (or use multi-destination via `transfer_data[]` if
     simpler)
3. Update `routes/payments.ts` and any other charge-creation site to
   use the new `createDestinationCharge` helper
4. Drop `property_allocation_rules.banking_fee_payer` column at the
   end (everything reads from the three new toggles by then)

S116 is the heaviest session of the rebuild — multiple files, money
math, careful smoke. May spill into S116a/S116b. After that S117–S120
are smaller focused sessions.

Realistic timeline: S116 by end of weekend. S117–S118 next week.
S119–S120 layer in after the May 18 contract sign. The schema is
ready for everything; the rest is wire-up.
