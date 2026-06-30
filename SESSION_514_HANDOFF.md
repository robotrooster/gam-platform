# SESSION 514 HANDOFF

Theme: **FlexDeposit advance→custody code rework** (launch follow-up #3 from S513) —
made `services/flexDeposit.ts` + all consumers match the signed Consumer ToS § 9.1
custody model. Then a cross-property-forwarding request surfaced a **foundational
finding**: `security_deposits` rows are never created in production. All work
uncommitted (Nic decides commits). One migration this session.

---

## A. FlexDeposit custody rework — SHIPPED, green

The advance/eat-the-gap/acceleration model is gone; the code now matches ToS § 9.1
(custody, not credit, no recourse). FlexSuite stays flag-hidden at launch
(`flexdeposit_rollout_visible`) — this was about code-matching-the-signed-ToS, not
shipping the feature.

**Nic decisions this session:**
1. Installments **2–6** (was 2–4), and **bigger deposit → MORE installments** (reversed
   the old advance-era "bigger = fewer" rule — under custody there's no GAM exposure to
   cap, so affordability wins). Tiers: ≤$500→2, ≤$1000→3, ≤$1500→4, ≤$2000→5, >$2000→6.
2. Stop-funding: a missed installment → installment marked `'missed'`, **plan stays
   `'active'`**, funded by later installments + GAM-first FIFO routing. No acceleration,
   no balance-due-in-full, no recourse (ToS § 9.1.5).
3. Re-enrollment softened to "until current" — dropped the permanent prior-default block
   and the 60-day NSF cooldown.
4. Acceleration retry replaced by a **voluntary pay-ahead** (optional early funding).
5. Custody-fee rule for a future forward (see arc C): pay top-up in one shot (or no
   top-up) → $3/mo custody fee stops; installment the top-up → fee continues unending.

**Changes:**
- **Migration `20260624130000_flexdeposit_custody_model.sql`** (applied, schema regen'd):
  installment_count CHECK 2..4→2..6; installment status `'defaulted'`→`'missed'`
  (CHECK now pending/settled/failed/missed); plan_status drops `'accelerated'`+`'in_default'`
  (now active/completed only); `gam_advance_amount`/`balance_due_*` columns marked
  DEPRECATED (kept, not dropped — drop needs Nic approval).
- **`packages/shared/src/index.ts`**: `FLEX_DEPOSIT_TIERS` re-tiered (2–6, bigger=more);
  removed `FLEX_DEPOSIT_NSF_COOLDOWN_DAYS`.
- **`services/flexDeposit.ts`**: header rewritten to custody; eligibility gains
  `not_ssi_ssdi` (gates on `tenants.ssi_ssdi`), drops cooldown + prior-default blockers,
  drops `suspended_until`; schedule `gamAdvanceAmount`→`uncollectedAtMoveIn`; enroll/preview
  bounds 2..6; stopped writing `gam_advance_amount`; `markInstallmentDefaulted`→
  `markInstallmentMissed` (no plan default); **deleted** `accelerateFlexDepositPlan` /
  `retry` / `settle` / `failFlexDepositAcceleration` / `markPlanInDefault`; **added**
  `payAheadFlexDeposit` + `settleFlexDepositPayAhead`.
- **`services/flexsuiteAcceptance.ts`**: `FLEXDEPOSIT_TEMPLATE_VERSION` 1.0.0→**2.0.0**;
  repointed `FLEXDEPOSIT_TEMPLATE_PATH` to new **`legal/FLEXDEPOSIT_CUSTODY_AGREEMENT.md`**
  (advance-model `FLEXDEPOSIT_SLA_TEMPLATE.md` no longer loaded — archival); removed
  `gamAdvanceAmount`/`Advance_Amount`, added `Custody_Fee`/`Deposit_Total`.
- **`services/supersedence.ts`**: FlexDeposit source now `status='missed'` (plan active);
  removed the `flexdeposit_acceleration` source + `satisfyFlexDepositAcceleration`.
- **`routes/webhooks.ts`**: acceleration settle/fail routing → pay-ahead; NSF dispatcher
  simplified (all installment failures → `handleFlexDepositPaymentNsf`).
- **`routes/tenants.ts`**: `/flexdeposit/retry-acceleration` → `/flexdeposit/pay-ahead`;
  LeasePage deposit context returns `unfunded_amount` instead of balance_due_*; bounds 2..6.
- **Frontend** (behind flag): tenant `main.tsx` enrollment disclosure rewritten (removed the
  acceleration paragraph that contradicted the ToS), "Service Agreement"→"Custody Agreement",
  `not_ssi_ssdi` blocker message; `LeasePage.tsx` accelerated/in_default banner →
  `FlexDepositPayAheadBanner` (voluntary).
- **Tests updated**: `flexDeposit.test.ts` (15), `tenants-flex.test.ts`, `supersedence.test.ts`
  (13), `flexsuiteAcceptance.test.ts`. Directly-affected + adjacent flex/payment suites green
  (≈300 tests). API `tsc` clean; tenant `vite build` green. Did NOT run the full suite (it has
  unrelated zombie-flaky appointment tests — see CLAUDE.md S414/S415).

## B. Out of scope (noted, not touched)
- `PLATFORM_FEES.FLOAT_FEE_MO = $20` in `payments.ts`/`admin.ts` is **FlexPay's** sliding-scale
  float fee (per Nic), a different product — not FlexDeposit's $3 custody fee.

## C. FOUNDATIONAL FINDING — blocks cross-property forwarding (+ FlexDeposit-live)

Nic asked for cross-property deposit forwarding (ToS § 9.1.6) "soon" — a tenant can move
property-to-property the moment a lease ends. The carry-forward re-point already exists
(`services/depositPortability.ts`, S255/S256). BUT:

**`security_deposits` rows are never created in production.** The only `INSERT INTO
security_deposits` in the whole repo is in test helpers. The live deposit is a `lease_fees`
row (`fee_type='security_deposit'`, S195/S196) billed at move-in. The `security_deposits`
table — read by FlexDeposit custody, deposit portability, OTP deposits, interest accrual,
and depositReturn — is read everywhere, written nowhere. So that entire subsystem is
pre-launch scaffolding not wired to the real deposit model. Forwarding/fee-dissolve/top-up
would be correct-looking code on a table prod never populates.

**Nic's call: wire the deposit lifecycle next (this is the real prerequisite).**

### S515 — wire `security_deposits` creation — SHIPPED, green

`security_deposits` rows are now created from the live `lease_fees` deposit model, so
FlexDeposit, portability, OTP-deposit, interest, and depositReturn have real data.

- **`services/leaseFeesSync.ts`**: `syncSecurityDepositLeaseFee` (the one helper, 4 call
  sites) now also calls new **`syncSecurityDepositRow(leaseId, amount, client)`** — an
  UPSERT (NOT delete-then-insert): creates a `pending` row with `held_by` mapped from
  `properties.deposit_handling_mode` ('landlord_held'→'landlord', else 'gam_escrow'),
  tenant = lease primary via `v_lease_active_tenants`. **No-clobber guards:** a row that's
  FlexDeposit-enrolled OR has `collected_amount>0` is left untouched; amount→0 deletes only
  an untouched row; missing primary tenant → skip (later sync/move-in creates it).
- New **`reconcileSettledDepositPayment(paymentId)`** wired in `routes/webhooks.ts` settle
  path: a settled `type='deposit'` payment bumps `collected_amount` + flips status
  funded/partial; skips FlexDeposit rows (their own reconcilers own collected). Idempotent
  via the webhook's settle-transition gate.
- **Migration `20260624140000_security_deposits_backfill.sql`** (applied): backfills rows
  for existing leases with a deposit fee but no row (0 in dev — no seed deposit fees;
  logic verified by tests). Re-runnable (NOT EXISTS guard); never clobbers existing rows.
- **Tests:** `services/securityDepositSync.test.ts` (10). Regression check across 12
  deposit/lease suites (onboarding, landlords, leases, CSV, depositReturn, esign,
  flexDeposit, tenants-flex, otp, flexsuiteAcceptance, supersedence) — 301 green. API tsc clean.

### S516 — cross-property custody forwarding (ToS § 9.1.6) — SHIPPED (common case); top-up automation deferred

Built on the S515 lifecycle. `executeDepositPortability` now merges into the target
lease's own S515 deposit row instead of leaving a duplicate, and applies the custody-fee
rule.

- **Migration `20260624150000_security_deposits_custody_fee_active.sql`** (applied):
  `security_deposits.custody_fee_active boolean NOT NULL DEFAULT true`. The custody-fee
  cron (`processFlexDepositCustodyFee`) now filters `AND sd.custody_fee_active = TRUE`.
- **`executeDepositPortability` (depositPortability.ts)**: reads the target lease's own
  (S515) deposit row; deletes it when untouched (no duplicate / no double-charge); re-points
  the carried funded row onto the target lease with `total_amount` = the new property's
  required deposit. Then, for gam_escrow deposits:
  - **fully funded by carry-forward (same/smaller deposit)** → status 'funded',
    plan 'completed', **custody_fee_active = FALSE** (ToS § 9.1.6 fee dissolves).
  - **larger deposit** → status 'partial', custody fee stays active; fires an admin
    notification (`deposit_portability_topup_owed`) with the top-up amount.
- **`settleFlexDepositPayAhead` (flexDeposit.ts)**: paying the deposit off in full via
  pay-ahead now also sets **custody_fee_active = FALSE** (Nic's "option 2 → fee stops").
- **Double-charge guard (`moveInBundle.ts`)**: a lease whose deposit row is
  `portability_status='carried_forward'` is NOT billed a fresh deposit at move-in.
- **Tests**: `services/depositForwarding.test.ts` (2 — same-size merge+fee-dissolve+dedup,
  larger→partial+fee-stays). Existing portability suites (s440Triplet 31, admin-deposit-connect
  11) + deposit/flex suites green. API tsc clean.

**Top-up automation — SHIPPED.** When the new property's deposit is larger, the forward now
auto-generates top-up installments for the difference (new `scheduleFlexDepositTopUp` in
flexDeposit.ts; tiers the difference, numbers rows after the original settled schedule, sets
pull dates for the cron). The option-1/option-2 choice is expressed by tenant BEHAVIOR rather
than an upfront field: let the installments ride → cron collects monthly, custody fee stays
(option 1); hit the pay-ahead button → one pull, custody fee stops (option 2). No upfront
choice field / UI needed. Admin alert reworded to "top-up scheduled". Covered by the larger
test in `depositForwarding.test.ts` (asserts the $500 top-up installments are generated,
numbered after the originals, pending for the cron).

The §9.1.6 cross-property forwarding is now functionally complete for the FlexDeposit case.
Residual (minor, non-blocking): a non-FlexDeposit gam_escrow deposit needing a top-up still
gets only the admin alert (no installment plan) — acceptable edge; landlord-held ports remain
the existing admin-mediated `pending_transfer` flow.

### Original follow-on note (superseded by S516 above)
- Custody fee dissolve: add `security_deposits.custody_fee_active boolean DEFAULT TRUE`;
  `processFlexDepositCustodyFee` filters on it. On forward: set FALSE when no top-up OR
  top-up paid in a single pull (option 2); leave TRUE when top-up taken as installments
  (option 1 — fee continues unending, per Nic).
- Top-up when new lease deposit > forwarded amount: tenant picks option 1 (installments on
  the difference, same tier treatment) or option 2 (single pull). Extend
  `depositPortability.ts` detect/authorize/execute to compute the difference + branch.
- Double-charge guard: ensure move-in at the new property recognizes the carried-forward
  deposit and doesn't bill a fresh `lease_fees` deposit.

## S517 — ToS /terms + signup gate: recon only — ALREADY BUILT (no code written)

Picked this as the next launch item; recon found it fully shipped, so nothing was built:
- `apps/marketing/server.js` renders all four legal pages from `legal/*.md` via `marked`:
  `/consumer/terms`, `/consumer/privacy`, `/business/terms`, `/business/privacy`, plus an
  audience picker at bare `/terms` + `/privacy`. All four render clean (verified).
- Signup gate wired front + back: landlord `RegisterPage` + tenant `AcceptInvitePage` carry
  the acceptance checkbox + deep-link to the audience-correct docs and send `acceptedTerms`;
  `auth.ts /register` requires `acceptedTerms: z.literal(true)` and stamps
  `users.accepted_tos_at` + `accepted_privacy_at` (tenant accept stamps them too).
- ToS split into business/consumer tracks per `legal/TOS_LEGAL_REVIEW.md`.
- **Real residuals (NOT code):** counsel review (required by TOS_LEGAL_REVIEW.md before public
  launch) + deploy the marketing server (port 3004, not in the launch trio) and set
  `VITE_MARKETING_URL` in landlord/tenant prod builds or the signup links 404.
- `LAUNCH_DECISIONS.md` #6 updated to RESOLVED/BUILT.

**Pattern noticed:** two launch items in a row (deposit portability, ToS surface) turned out
already-built — LAUNCH_DECISIONS.md is stale in places.

## S517 — launch-readiness audit — RAN (3 parallel Explore sweeps); POS leaks fixed

**Confirmed DONE (LAUNCH_DECISIONS stale):**
- **Frontend Sentry (#9)** — ALL 6 portals have @sentry/react dep + Sentry.init (`lib/sentry.ts`,
  gated on `VITE_SENTRY_DSN`) + `SentryErrorBoundary` at root. Doc #9 is stale.
- **ToS /terms + signup gate (#6)** — done (S517 above).
- **Platform fee $2 (#34)** — admin income calc uses `LAUNCH_PLATFORM_FEE.PER_OCCUPIED_UNIT`
  (admin.ts:393). The audit's "$15" flag was a MISREAD of a historical comment — verified false.
- **Email senders / Stripe key wiring / app URLs** — all env-driven w/ localhost dev fallbacks;
  dev-mock payment paths are `NODE_ENV==='production'` gated. Prod just needs the env values set.

**Fixed this session — 2 POS feature-hiding leaks (apps/pos/src/pages/POSPage.tsx):**
- Refund-modal copy "Reverses on FlexCharge account" (line ~1408) now guarded by `LAUNCH_HIDE_CHARGE`.
- Items-config "Charge eligible" checkbox (~785) + "Charge" table header (~829) + Yes/No toggle
  cell (~852) now guarded by `LAUNCH_HIDE_CHARGE` (header + cell guarded together to keep columns
  aligned). POS `vite build` green. Landlord + Tenant feature-hiding confirmed CLEAN (all
  non-launch routes have redirect guards, nav filtered, KPIs conditional).

**2FA frontend rollout — SHIPPED this session (Nic greenlit all four).** Replicated the admin
TOTP pattern into all four remaining portals via parallel agents; each independently tsc-clean +
vite-build green (re-verified by me):
- **admin-ops** (`main.tsx`) — MANDATORY: 2-step login challenge + TotpEnrollPage +
  `MustEnrollTotpGate` wrapping the shell + Security page. Uses its `gam_admin_ops_token` key.
- **landlord** (`context/AuthContext.tsx`, `pages/LoginPage.tsx`, new `pages/TotpEnrollPage.tsx`,
  `SettingsPage` SecurityCard, `Layout` TotpNudge) — optional-with-prompts (dismissible nudge, no gate).
- **tenant** (`main.tsx`) — optional: login challenge + `/security` + `/security/enroll`, no nudge/gate.
- **pm-company** (`AuthContext.tsx`, `LoginPage.tsx`, new `TotpEnrollPage.tsx`, `SettingsPage`
  SecuritySection, `TotpNudge`) — optional-with-prompts.
- All use the backend contract: login → `requiresTotp`/`totpSession` or token+flags; `/totp/verify`
  {totpSession,code}→token; `/totp/enroll-start`→{otpauthUrl,qrDataUri,recoveryCodes};
  `/totp/enroll-confirm` {token:code}; `/totp/disable` {password}. The login challenge is the
  critical anti-lockout piece and is present in all four. LAUNCH_DECISIONS #5 now fully resolved.

**Real pending — Nic / infra / counsel (NOT code-blocking):**
- Deploy config (no Dockerfile/render.yaml — host is dev-team, #1); prod env vars (Stripe live,
  EMAIL_FROM_*, app URLs incl. VITE_MARKETING_URL, VITE_SENTRY_DSN); ToS counsel review (#6);
  Stripe live activation + Financial Connections (replaces dev-mock SetupIntent, non-blocking).
- Scheduler OTP/disbursement crons commented out (deferred, non-blocking — launch uses FlexPay).

## SHUTDOWN STATE (all green, uncommitted — Nic decides commits)

- FlexDeposit custody rework (S514) + deposit-lifecycle wiring (S515) + cross-property
  forwarding incl. top-up (S516): complete, API tsc clean, directly-affected suites green.
- 3 migrations applied this chat + schema.sql regen'd:
  `20260624130000_flexdeposit_custody_model`, `20260624140000_security_deposits_backfill`,
  `20260624150000_security_deposits_custody_fee_active`.
- New test files: `flexDeposit.test.ts` (updated), `securityDepositSync.test.ts`,
  `depositForwarding.test.ts`, plus updated tenants-flex / supersedence / flexsuiteAcceptance.
- No half-finished edits. The launch-readiness audit was read-only and cancelled before running.

## How to resume
- `~/gam-start.sh` boots everything. Logins/ports per CLAUDE.md.
- Green suites this session: `cd apps/api && npx vitest run src/services/flexDeposit.test.ts
  src/services/supersedence.test.ts src/routes/tenants-flex.test.ts
  src/services/flexsuiteAcceptance.test.ts`
- If the test suite is slow/flaky: `pgrep -fl ts-node-dev` then `bash kill-all.sh` (S414/S415).
