# Session 114 Handoff

**Theme:** Stripe Connect Express rebuild — Session 1 of the
multi-session plan. Schema migration only. Adds the scaffolding for
per-user/per-pm-company Connect accounts, splits the per-property
fee-payer toggles into three independent fields, and creates the
config + override + accrual tables for the $2/occupied-unit + $10/
property/min platform fee with superadmin-tunable rates.

NO route or service changes this session. The legacy 16a allocation
engine still reads `banking_fee_payer` (kept as deprecated mirror); the
S116 allocation refactor will retire it after S115 wires the actual
Connect onboarding flow.

## Architecture context (locked S113)

This rebuild supersedes the S78 "Stripe inbound only / no Treasury /
TBD bank rail" decision. Stripe Connect Express + destination charges
is the rail in BOTH directions. See:
- `/Users/nicholasrhoades/.claude/projects/-Users-gold-Downloads-gam/memory/project_stripe_connect_rail.md`
- `/Users/nicholasrhoades/.claude/projects/-Users-gold-Downloads-gam/memory/project_gam_pricing_model.md`
- CLAUDE.md "Stripe Connect Express + destination charges" section

Multi-session rebuild plan (S114 → S120):
- **S114 (this session)**: schema migration ✓
- S115: Connect account creation flow + embedded `<ConnectAccountOnboarding />` hosting
- S116: destination-charge wiring + allocation engine refactor (`application_fee_amount`, `transfer_data`)
- S117: webhook handling for Connect events
- S118: GAM-native dashboard build (payouts list, account management, payment history)
- S119: PM Companies money-flow refactor under destination charges
- S120: per-occupied-unit platform fee accrual cron (RV/STR aggregation rule)

May 18 contract deadline. S114–S118 should land before signature so
the implementation goes into Stripe sandbox; S119–S120 layer in after.

## Architecture decisions

**Three independent per-property fee toggles** (replaces single
`banking_fee_payer`). Per S113 product call: every fee GAM charges has
its own per-property pass-through toggle. GAM never absorbs anything;
the landlord chooses for each fee whether tenant pays on top or
landlord absorbs from gross. Three toggles:
- `ach_fee_payer` — controls 1.0% capped $6 ACH processing fee
- `card_fee_payer` — controls 3.25% card processing fee
- `platform_fee_payer` — controls $2/unit + $10/min SaaS fee
Backfilled both processing fields from existing `banking_fee_payer`
to preserve current behavior. `platform_fee_payer` defaults to
'landlord' (current implicit behavior).

**`banking_fee_payer` deprecated, kept one session.** The legacy
allocation engine still reads it. S116 refactor will retire the
column after the engine is rewritten to read the three new toggles.
COMMENT on the column documents the deprecation.

**Effective-dated rate config.** `platform_fee_config` and
`landlord_platform_fee_overrides` use a partial UNIQUE on
`effective_until IS NULL` to enforce one-active-row-at-a-time.
Superadmin rate changes end-date the old row and INSERT a new one,
preserving historical math for accruals already posted.

**At-least-one-field on overrides.** A landlord override row that's
NULL on both `rate_per_unit` and `min_per_property` is meaningless
(it would inherit everything from the platform default). CHECK
constraint `landlord_pfo_at_least_one` rejects.

**Accrual snapshot fields.** `platform_fee_accruals` snapshots
`rate_per_unit`, `min_per_property`, `payer`, plus the unit-math
breakdown (long_term_unit_count, short_stay_nights,
short_stay_equivalent, total_billable). Future rate edits don't
retroactively change historical billing. Same posture as
`pm_monthly_fee_accruals` (S111).

**Stripe Connect account ids on users + pm_companies.** Per S113
locked decision: per-user Connect accounts (one Connect account per
`users.id`), pm_companies always get one, managers opt-in via
landlord toggle (default off). Both columns are nullable text with
partial UNIQUE indexes — a Connect id can't appear on two rows.

## Shipped

### Migration `20260504040000_stripe_connect_rebuild_schema.sql`

```
users
  + stripe_connect_account_id text (nullable)
  + idx_users_stripe_connect_account_id (UNIQUE WHERE NOT NULL)

pm_companies
  + stripe_connect_account_id text (nullable)
  + idx_pm_companies_stripe_connect_account_id (UNIQUE WHERE NOT NULL)

property_allocation_rules
  + ach_fee_payer       text NOT NULL (CHECK landlord|tenant)
  + card_fee_payer      text NOT NULL (CHECK landlord|tenant)
  + platform_fee_payer  text NOT NULL DEFAULT 'landlord' (CHECK landlord|tenant)
  - banking_fee_payer   (kept; commented as deprecated)
  Backfill: ach_fee_payer = card_fee_payer = banking_fee_payer

platform_fee_config (NEW)
  rate_per_unit numeric DEFAULT 2.00
  min_per_property numeric DEFAULT 10.00
  effective_from date DEFAULT CURRENT_DATE
  effective_until date (nullable; one-active-row partial UNIQUE)
  set_by_user_id, notes
  CHECK rate_per_unit >= 0, min_per_property >= 0
  CHECK effective_until > effective_from
  Seeded: ($2, $10) — S113 launch defaults

landlord_platform_fee_overrides (NEW)
  landlord_id (CASCADE)
  rate_per_unit / min_per_property (both nullable, at-least-one CHECK)
  effective_from / effective_until (one-active-per-landlord partial UNIQUE)
  set_by_user_id, reason

platform_fee_accruals (NEW)
  landlord_id (RESTRICT) + property_id (RESTRICT) + accrual_month (date)
  long_term_unit_count, short_stay_nights, short_stay_equivalent, total_billable
  rate_per_unit, min_per_property, total_amount  (snapshots)
  payer ('landlord' | 'tenant')
  platform_revenue_ledger_id, tenant_charge_id
  UNIQUE(landlord_id, property_id, accrual_month)
```

## Files touched

- `apps/api/src/db/migrations/20260504040000_stripe_connect_rebuild_schema.sql` (new)
- `apps/api/src/db/schema.sql` (regenerated, 7935 → 8144 lines)
- `SESSION_114_HANDOFF.md` (this file)

Plus memory updates earlier in the session:
- New `project_stripe_connect_rail.md` (replaced `project_bank_rail_tbd.md`)
- New `project_gam_pricing_model.md` (locked $2/unit + $10/min, RV/STR aggregation, three fee toggles)
- New `project_flexsuite_otp_hidden.md` ("don't surface FlexSuite/OTP in portals")
- Updated `project_team_permissions_model.md` (PM company creation gate clarified — open create, gated operation via standard property onboarding)
- Updated MEMORY.md index
- Removed obsolete `project_bank_rail_tbd.md` and `project_stripe_pause.md`
- CLAUDE.md "Disbursement and payout model" section rewritten as "Stripe Connect Express + destination charges"

## Validation

- `npm run db:migrate` → 1 applied; schema.sql regenerated to 8144 lines
- `npx tsc --noEmit -p apps/api/tsconfig.json` → exit 0
- 10-step schema smoke (rolled-back transaction):
  1. `platform_fee_config` seeded at $2/$10 active ✓
  2. `property_allocation_rules` backfill: ach + card mirror banking_fee_payer; platform default 'landlord' ✓
  3. CHECK rate_per_unit >= 0 rejects negative ✓
  4. Partial UNIQUE rejects two simultaneously-active platform_fee_config rows ✓
  5. CHECK effective_until > effective_from rejects backward ranges ✓
  6. CHECK at-least-one-field on overrides rejects all-NULL ✓
  7. One-active-override-per-landlord partial UNIQUE rejects duplicates ✓
  8. CHECK fee_payer enum rejects 'gam' ✓
  9. platform_fee_accruals UNIQUE rejects (landlord, property, month) duplicates ✓
  10. stripe_connect_account_id partial UNIQUE rejects two users sharing an id ✓

## What this session did NOT do

- **No route changes.** The Connect account ids exist on `users` and
  `pm_companies` but nothing reads them yet. No Connect onboarding
  flow exists. POST/GET/PATCH on these tables continues to work as
  before; new fields are nullable and unused.
- **No service-layer changes.** The allocation engine still reads
  `banking_fee_payer` (the deprecated column). S116 will refactor it
  to consume the three new toggles.
- **No UI surface for the fee toggles.** Landlords today can only
  edit `banking_fee_payer` via existing routes; the three new toggles
  are write-blocked at the route layer until S116/S117 add the
  PATCH endpoint. Until then, all rows behave as if landlord controls
  ACH+card via the legacy field, and platform_fee_payer is always
  'landlord'.
- **No platform fee accrual cron.** Schema is ready. The cron that
  walks landlords each month, computes the long-term + short-stay
  aggregation, and posts to `platform_fee_accruals` lands in S120.

## What next session (S115) targets

Connect account creation flow:

1. New service `services/stripe/connectAccount.ts` with helpers for:
   - Create a Custom Connect account for a user / pm_company
   - Generate an Account Session token for the embedded onboarding
     component
   - Look up the current account state (requirements_due, payouts_enabled)
2. New route(s):
   - `POST /api/stripe/connect/onboarding-session` — returns an
     Account Session client_secret to render
     `<ConnectAccountOnboarding />` inside GAM's UI
   - `GET /api/stripe/connect/status` — returns the caller's current
     Connect account state (requirements_due, charges_enabled,
     payouts_enabled)
3. Webhook handler (`account.updated`) to keep GAM's view of the
   Connect account state fresh after KYC completes
4. Frontend prep: a single React component that mounts the embedded
   onboarding once we have the client_secret. Probably parked under
   `apps/landlord/src/pages/StripeConnectOnboarding.tsx` and
   referenced by the existing landlord onboarding flow when a
   landlord is missing `users.stripe_connect_account_id`.

S115 is realistically one focused session. S116 (destination charges)
is the heavier lift after.

## Pre-launch blockers still open

- ~~Item 16 batch 2 — bank ACH origination provider~~ — CLOSED at S113;
  Stripe Connect is the rail in both directions
- Item 16 batch 3+ — OTP enablement (now reframed as "OTP under
  Connect" rather than "OTP under TBD rail")
- Item 10 — utility billing payment integration (will compose with
  destination charges naturally once S116 lands)

Plus the rest of the Connect rebuild (S115–S120).
