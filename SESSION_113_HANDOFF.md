# Session 113 Handoff

**Theme:** Architecture rewrite. Stripe Connect Express + destination
charges is now the locked rail. **No code changed.** Documentation,
memories, and the multi-session rebuild plan only. S114+ executes.

## What changed

### Architectural decision retracted

The S78 decision ("Stripe is INBOUND ONLY / NO Treasury / outbound TBD
bank rail") is **retracted**. Stripe will be the rail in both
directions.

### New rail: Stripe Connect Express + destination charges

Confirmed via the Stripe proposal (Darby Sween, Platforms Growth,
2026-05-04). Contract sign-by deadline May 18.

| Setting | Value |
|---|---|
| Connect product | **Express** |
| Dashboard | Express (we replace it with native UI for everything except onboarding) |
| Fee collection | application = GAM |
| Loss responsibility | application = GAM |
| Money flow | **Destination charges** |
| Embedded components | **Onboarding only.** Payouts/account-mgmt/dashboard built native by GAM |
| KYC | Stripe-hosted form embedded in GAM URL ("Powered by Stripe" footer is unavoidable on Express; acceptable tradeoff) |
| Add-ons in for launch | Financial Connections + Radar |
| Add-ons deferred | Smart Disputes, Authorization Boost |

### Locked answers — Connect scope

- One Connect account per `users.id`
- PM companies always get Connect accounts
- Managers (`property_manager_scopes` users): opt-in toggle, default off
  (per-manager flag — landlord enables direct deposit per worker)

### Locked answers — pricing

| Layer | Rate |
|---|---|
| ACH (tenant-facing) | 1.0% capped at $6.00, platform-wide |
| Card (tenant-facing) | 3.25% flat, platform-wide |
| Canadian card USD | +1.5% surcharge passed through to tenant |
| Per-occupied-unit platform fee | $2/unit/month default |
| Per-property minimum | $10/month |
| Vacant units | NEVER charged (only `units.status='active'` counts) |
| Superadmin overrides | Per-landlord rate cuts allowed |
| Cash/check | NOT SUPPORTED — electronic only |
| MCC overrides | NOT BUILT — platform-wide flat |

Stripe costs (pulled from the proposal email):
- ACH: 0.5% capped at $3.00
- Card: IC+ (interchange + 0.7% + $0.26)
- Connect account fee: $1/active account/month (absorbed into
  per-property platform fee — not separately billed)
- Canadian card surcharge: 1.5% (passed through to tenant)

### Documentation updated

- `CLAUDE.md` — "Disbursement and payout model" section rewritten;
  S78 decision retracted; new Connect Express + pricing model
  documented
- `project_stripe_connect_rail.md` memory created
- `project_gam_pricing_model.md` memory created
- `project_bank_rail_tbd.md` memory deleted (obsolete)
- `project_stripe_pause.md` memory deleted (obsolete — was a stub
  for "Stripe pricing locked at IC+", superseded by full pricing model)
- `MEMORY.md` index updated

## What was deliberately NOT touched

- `services/disbursementFiring.ts` — still rail-switchable. Will
  retire / repurpose in S116.
- `services/allocation.ts` — still posts split entries to
  `user_balance_ledger`. Refactor in S116.
- `services/autoPayouts.ts` — still sweeps user_balance_ledger.
  Refactor in S116/S117.
- `pm_companies.bank_account_id` field — repurposed in S114 to point
  at the Connect account's external bank, not user_bank_accounts.
- `user_bank_accounts` table — historical; new flows use Connect
  external accounts. Decision deferred to S114 whether to fully
  retire or keep for legacy data.

The 16a allocation engine (S64–S110) and PM Companies subsystem
(S107–S112) are NOT being deleted. The schema and routes survive.
The money-movement layer is what gets rebuilt.

## Files touched in S113

- `CLAUDE.md` (architecture decision section rewritten)
- `~/.claude/projects/-Users-gold-Downloads-gam/memory/MEMORY.md` (index)
- `~/.claude/projects/-Users-gold-Downloads-gam/memory/project_stripe_connect_rail.md` (new)
- `~/.claude/projects/-Users-gold-Downloads-gam/memory/project_gam_pricing_model.md` (new)
- `~/.claude/projects/-Users-gold-Downloads-gam/memory/project_bank_rail_tbd.md` (deleted)
- `~/.claude/projects/-Users-gold-Downloads-gam/memory/project_stripe_pause.md` (deleted)
- `SESSION_113_HANDOFF.md` (this file)

No code changes. No migrations. No tests.

## Multi-session rebuild plan

Realistic timeline: 5–7 sessions. Order matters.

### S114 — Schema migration (Connect account ids + pricing tables)

- Add `users.stripe_connect_account_id` (uuid... no wait, Stripe IDs
  are strings like `acct_*`; field type = text)
- Add `users.connect_charges_enabled` boolean (mirror of Stripe's
  `charges_enabled` capability; updated by webhook)
- Add `users.connect_payouts_enabled` boolean (same posture)
- Add `users.direct_deposit_enabled` boolean for managers (default
  false; opt-in per landlord)
- Add `pm_companies.stripe_connect_account_id` text (replaces or
  augments the existing `bank_account_id` field)
- New `platform_pricing_rates` table with the platform-wide defaults
  ($2/unit, $10/property min, 1.0% ACH cap $6, 3.25% card flat) —
  superadmin-editable
- New `landlord_pricing_overrides` table (per-landlord rate cuts;
  effective_from / effective_until)
- New `platform_revenue_ledger` row types if needed for the new
  fee-cut categories
- New `connect_account_events` audit table (log every Stripe webhook
  for this account: account.updated, payout.paid, etc.)

### S115 — Connect onboarding flow

- New endpoint `POST /api/stripe/connect/onboard` — creates a Connect
  Express account via Stripe API, generates an account session token
  for the embedded component, stamps the account ID on the
  user/pm_company row
- New endpoint `GET /api/stripe/connect/onboarding-link` — returns
  the AccountSession secret for the embedded component to render
- New endpoint `GET /api/stripe/connect/account-status` — fetches
  current `requirements.currently_due[]` and capabilities
- Frontend: embed `<ConnectAccountOnboarding />` in landlord/PM
  onboarding flow
- Webhook handler: `account.updated` event → update charges_enabled,
  payouts_enabled flags
- Smoke walk: create test account via Stripe Test mode, verify
  embedded component renders, complete KYC, verify webhook updates
  the flags

### S116 — Destination charge wiring + allocation engine refactor

- Rewrite `services/allocation.ts` for destination-charge model:
  - Compute `application_fee_amount` at charge creation, not
    post-settlement
  - Determine destination Connect account (landlord's, or via
    multi-destination if PM company involved)
  - Pass `transfer_data` to PaymentIntent
- Retire / repurpose `services/disbursementFiring.ts`
- Update payment route(s) that create rent PaymentIntents to use
  the new flow
- Webhook handler: `charge.succeeded` and
  `application_fee.created` to log GAM's revenue
- The `user_balance_ledger` keeps existing entries for historical
  audit; new entries for OBSERVATION ONLY (snapshot of what Stripe
  did) — not as the source of truth for money movement
- Smoke walk: create a test PaymentIntent with destination + app fee,
  verify Stripe routes correctly, verify our ledger snapshot matches

### S117 — PM Companies money-flow refactor

- PM company gets a Connect account (S114 added the field)
- PM cuts under destination charges: post-charge `Transfer` from
  landlord Connect → PM company Connect, OR multi-destination
  `transfer_data[]` at charge time
- The S110 + S111 `allocation_pm_company_fee` ledger entries become
  observability records of the Stripe Transfer events
- `pm_monthly_fee_accruals` (S111) — posts a Stripe Transfer call
  on the 1st of the month instead of writing to user_balance_ledger
- Owner-visibility view (S110) — query Stripe API for the actual
  payouts + cuts, OR continue reading from observability ledger
- Smoke walk: 8% PM plan + $1000 charge → verify $920 lands on
  landlord Connect, $80 transfers to PM Connect, GAM keeps
  application_fee_amount

### S118 — Native dashboard build (replaces embedded components)

- Landlord-portal endpoints + UI for:
  - Payout list (call Stripe `GET /v1/payouts?stripe_account=...`,
    render in GAM UI)
  - Account management (bank account update form posting to
    Stripe `POST /v1/accounts/:id`)
  - Notification banner for `requirements.currently_due[]` items
  - Payment history (already exists; just join Connect data)
  - 1099 retrieval (Stripe issues directly via mail; we surface a
    "your 1099 will arrive by mail at the address on file" notice)

### S119 — Per-occupied-unit platform fee accrual + Canadian card pass-through

- Monthly cron walks active landlords, computes per-property fee
  based on `units.status='active'` count for the month
- Posts platform_revenue_ledger entry (this is GAM's SaaS-side
  revenue line, separate from the per-transaction spread)
- Superadmin override lookup: check `landlord_pricing_overrides`
  before falling back to platform defaults
- Canadian card detection: at PaymentIntent creation, read
  `payment_method.card.country`. If non-US, add 1.5% to the
  customer-facing rate before computing `application_fee_amount`
- Smoke walks for each path

### S120 — Webhook coverage + edge cases

- Full webhook handler buildout for all relevant Connect events:
  - `account.updated` (capability changes)
  - `account.application.deauthorized` (landlord disconnects — if
    even possible in our flow)
  - `charge.dispute.created` / `.updated` / `.closed` (since GAM
    has loss_responsibility=application)
  - `charge.refund.updated` (refund flow)
  - `payout.paid` / `.failed`
  - `transfer.created` / `.failed` (for our PM-cut transfers)
- Edge cases:
  - Manager direct-deposit opt-in/out flow
  - Landlord disconnects bank mid-payout cycle
  - Tenant ACH return (NSF, R01-R85 codes) — already partially
    handled in `nachaMonitoring`; needs Connect-aware version
  - Connect account verification stuck in `requirements.disabled_reason`

## Pre-launch blockers under the new model

The launch blocker list shrinks dramatically:

**Closed by S113 architecture lock:**
- ~~Item 16 batch 2 — bank ACH origination provider~~ (no longer
  needed; Stripe is the rail)
- ~~FlexSuite Stage 2 gating on rail~~ (FlexPay/Charge/Deposit pulls
  use Stripe directly)

**Still open:**
- Item 16 batch 3+ — OTP enablement (FlexPay SetupIntent flow —
  now uses Financial Connections per S113 add-on decision)
- Item 10 — utility billing payment integration (gated on S116
  destination-charge wiring)
- BG check production provider (separate concern; Checkr Trust
  pending)
- SMS provider (Twilio etc., unrelated to rail)

## What this session did NOT do

- **Touch any code.** This is a pure documentation/architecture
  rewrite session.
- **Strip the existing 16a allocation engine.** It survives until
  S116 explicitly refactors it.
- **Strip `services/disbursementFiring.ts`.** Same — survives until
  S116.
- **Wire the new add-ons (Financial Connections, Radar).** Those land
  alongside their respective flows in S115/S116.

## Action items that need your input before S114 starts

None blocking — all locked. But two FYIs:

1. **Pricing PDF**: when you have the proposal in hand, paste the
   pricing PDF text. I have the numbers from your messages but want
   to verify against the contract before wiring exact rates.
2. **Stripe sandbox / test mode credentials**: S115 will need real
   Stripe Test mode keys (publishable + secret + webhook signing
   secret). These should already be in the existing `.env` if
   prior Stripe work was wired (S83 background-check intake fees).
   Verify they're current Test mode keys, not stale.

## Recommendation for next session

**S114** (schema migration) — small, low-risk, unblocks S115. Can
ship in one focused session. Want me to proceed? Or is there
anything else to discuss before I touch the schema?
