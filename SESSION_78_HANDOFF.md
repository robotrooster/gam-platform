# Session 78 Handoff

**Theme:** Item 16 batch 1 — disbursement firing service (rail-switchable,
flag-gated stub default). Plus a CLAUDE.md hygiene pass that struck 5 stale
schema landmines and 4 stale "notable known items."

## CLAUDE.md hygiene (recon contradicted the brief)

S77 spotted one stale entry. S78 audited the rest and found seven more.
Verified each claim against current src + DB before striking.

**Schema landmines struck (already shipped or false positive):**

| Entry | Reality |
|---|---|
| Background check subsystem | Shipped S59 (Checkr Trust hybrid). `tenants.background_check_id` + `_status` exist with full CHECK; `application_pool` + `pool_match_requests` tables exist. |
| Properties endpoint $9 + amenities | Both reconciled out at S60 as false positives (DEFERRED.md S60 entry). |
| ReportsPage `/summary` missing | `reports.ts:28` has `reportsRouter.get('/summary', ...)`. Endpoint exists. |

**Schema landmines kept:** PM subsystem (still missing `pm_companies`,
`pm_fee_plans`, `landlords.pm_company_id`/`pm_fee_plan_id`); Master
Schedule (column count corrected to 3 on units + 6 on unit_bookings = 9);
GAM Books AZ hardcoding (line numbers added).

**Notable known items struck:**

| Entry | Reality |
|---|---|
| Static schema diff harness | `apps/api/scripts/diff-schema.ts` exists. |
| `lib/stripe.ts:67/:93` Connect calls | Removed S67. Zero `stripe.transfers` / `stripe.accounts.create` in src. |
| `payments.ts:121 initiate-disbursements` | Route doesn't exist. |
| Reserve fund replenishment TODO | Removed S68. `webhooks.ts:64` confirms current model is forward-funding, no replenish needed. |

**Notable known items kept:** PropertyType placeholder in shared.

## Item 16 batch 1 — what shipped

### Architecture

`apps/api/src/services/disbursementFiring.ts` — new `fireDisbursement(id)`
service, the bridge between autoPayouts queueing 'pending' rows and
webhooks settling 'settled' rows. State machine:

- `pending` (queued by autoPayouts.ts) → fire attempted
- `pending` → `processing` on success (`stripe_payout_id` stamped, `initiated_at` set)
- `pending` → `failed` on error (`notes` carries timestamped error)
- `failed` → re-fireable via admin endpoint
- `processing` → `settled` arrives via existing Stripe webhook (`webhooks.ts:89`)

Idempotent on input: refuses to re-fire `processing` or `settled`.

### Rail switch via `DISBURSEMENT_RAIL` env

- `'stub'` (default) — synthetic `stub_payout_<dispId>_<ts>` IDs, advances
  to `'processing'` without firing real ACH. Stub payouts never settle on
  their own; that's fine for smoke testing the queue/fire path.
- `'bank_ach'` — currently throws. Wires GAM's chosen ACH origination
  provider (Increase / Column / Modern Treasury / Mercury / direct bank
  API / NACHA file). State machine is provider-agnostic; only the
  `fireViaBankAch` body and the settlement-side webhook handler change
  per provider.

### Architecture decision recorded

Stripe is INBOUND ONLY (tenant debits / cards, IC+ priced). Outbound ACH
credits to landlords originate from GAM's bank rail. GAM self-manages
ACH origination risk (NSF, returns, fraud). NO Stripe Treasury. Captured
in CLAUDE.md disbursement-model section + lib/stripe.ts comment block.

### Wired into autoPayouts engine

`apps/api/src/jobs/autoPayouts.ts` — `processAutoPayouts` now runs in
two phases: queue (existing, unchanged transactionally) then fire (new).
Separate phases so a transient firing failure can't roll back the
disbursement insert. `PayoutResult` adds `firingsSucceeded` /
`firingsFailed` counters. `queueOnePayout` return type changed from
union string to discriminated `{ kind: 'queued'; disbursementId } | ...`
so the fire phase can pull the new IDs.

### Manual retry endpoint

`POST /api/admin/disbursements/:id/fire` — admin/super_admin gated.
Calls `fireDisbursement`, audits via `logAdminAction` (action_type
`disbursement_fire` or `disbursement_fire_failed`, metadata records
`rail` + `stripe_payout_id`). Returns the updated row. 409 on failure.

## Files touched

- apps/api/src/services/disbursementFiring.ts (new)
- apps/api/src/jobs/autoPayouts.ts (fire phase + return type)
- apps/api/src/routes/admin.ts (POST /disbursements/:id/fire)
- .env.example (DISBURSEMENT_RAIL)
- CLAUDE.md (struck 5 stale schema landmines + 4 stale notable known items)
- DEFERRED.md (Item 16 batch 1 progress + batch 2/3 outstanding)
- SESSION_78_HANDOFF.md (this file)

## Validation

- `cd apps/api && npx tsc --noEmit` → exit 0
- No migrations needed — existing disbursements columns
  (`status`, `stripe_payout_id`, `initiated_at`, `notes`) cover the state
  machine.

## Pre-launch blockers still open

- Item 16 batch 2 — bank ACH origination provider selection + real
  `fireViaBankAch` call + settlement webhook/polling handler.
- Item 16 batch 3+ — applicant bg check payment (Stripe PaymentIntent,
  rail-independent), OTP enablement, pool unlock $1, mock pi_* replacement.
- Item 2 — FCRA adverse action notice infrastructure.
- Item 10 — Utility billing subsystem (multi-day).
- Item 11 — Master Schedule finish-or-strip (needs Nic's product call).
- Item 14 — POS app completion (multi-day).
- Item 15 — E-sign frontend visual + e2e smoke.
- Item 19 — Email systems consolidation.

## What next session should target

Top picks for S79:

1. **Item 19 — Email consolidation** — Resend (services/email.ts) vs
   nodemailer (lib/email.ts). nodemailer has known npm audit blockers.
   Bigger blast radius, deserves its own session.
2. **Item 11 — Master Schedule** — needs Nic's build-vs-strip product call.
3. **Item 8 — Team UI rebuild** — `team_property_access` phantom + invite
   columns on team_members. Smaller, contained.
4. **Item 16 batch 3** — applicant bg check payment via Stripe
   PaymentIntent. Rail-independent of batch 2.

Item 16 batch 2 needs Nic's bank ACH origination provider call before any
code can land. Worth a scope-shaping conversation at start of S79 if this
is the planned target.
