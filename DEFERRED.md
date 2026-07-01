# GAM — finish-line list

Single source of truth for everything still needed to take GAM from
feature-complete to launched. Replaces the prior feature-only
DEFERRED. Each item shipped → delete it from this file (audit trail
lives in handoffs + git per CLAUDE.md).

## Top-line state

- **Feature work for launch**: effectively done. Flex Suite
  (FlexPay / FlexCharge / FlexDeposit / FlexCredit) is **hidden at
  launch by feature flag**, tested on backend post-launch — not in
  the launch-critical path.
- **Production infrastructure**: tests + CI + error tracking +
  structured logging all shipped. **Test suite at 618 across 32
  files** (S333 close — up from 272/22 at S332). Remaining gaps:
  deploy config (host pick), production cron runner, DB backups —
  all dev-team scope.
- **Legal**: ToS + Privacy Policy drafted (S291). Engineering
  scaffolding shipped — `/terms` + `/privacy` pages on marketing
  site, `users.accepted_tos_at` / `accepted_privacy_at` columns,
  signup acceptance gate on landlord / tenant (BackgroundCheckPage
  + AcceptInvitePage) / pm-company portals. Lawyer review of
  arbitration + limitation-of-liability clauses recommended
  before broad public rollout.
- **Vendor go-lives**: Stripe Connect keys (agreement signed,
  flip test → live), Resend domain auth, Plaid production keys,
  Stripe Terminal hardware, Checkr Partner credentials (Monday).

Feature-flag wiring is in place: `system_features` table +
`isFeatureEnabled(key)` helper, per-Flex-product
`isFlexXVisible()` gates. At launch the flags stay off; the
products literally don't render and the crons no-op.

Suggested launch sequencing at the bottom.

---

## Critical for launch (must have to take real money)

### Tests

S265 landed the Vitest harness in `apps/api` against a real `gam_test`
Postgres fixture (schema-loaded from `schema.sql` snapshot, per-test
transactions rolled back). `npm test` from `apps/api` runs the suite.
Remaining critical-path coverage for launch-day flows:

- ~~Allocation engine math (`services/allocation.ts`): in-house
  manager floor/ceiling, banking spread, processing fee payer
  toggles, supersedence, idempotency, rejects, PM company cut
  path (percent variants + replaces-manager semantics +
  no-bank rejection).~~ **shipped S265–S266**
  (`src/services/allocation.test.ts`, 16 cases).
- ~~Rent webhook handler (`routes/webhooks.ts`):
  `payment_intent.succeeded` (rent + utility branches),
  `payment_intent.payment_failed` (NACHA retry decisioning),
  `charge.dispute.created/updated/closed`.~~ **shipped S270–S272**
  (18 cases). **S284 added 4 `account.updated` cases** (KYC clear
  → users / pm_companies, no-match silent no-op, partial KYC).
  Webhook test surface complete — 22 cases.
- ~~Deposit-return finalize (`services/depositReturn.ts`):
  `collected_amount` pool + S262 Connect Transfer to landlord's
  Connect account at lease-end.~~ **shipped S267** workflow-only
  (`src/services/depositReturn.test.ts`, 14 cases) — Stripe Transfer
  + gap auto-charge exercised via their no-credentials-on-file
  fallback branches (admin notification, gap_charge_failed=TRUE), not
  via real Stripe calls. Real money-movement assertions deferred to
  the post-Stripe-live-keys integration round.
- ~~POS sync queue drain (`apps/pos/src/lib/syncQueue.ts`): FIFO +
  4xx-discard + 5xx-backoff + clientId resolution.~~ **shipped S268**
  (`apps/pos/src/lib/syncQueue.test.ts`, 15 cases). jsdom +
  fake-indexeddb harness reusable for any future frontend logic
  tests in apps/pos.
- ~~Standard lease lifecycle: sign → move-in invoice generates →
  monthly rent invoices fire → late fee applies on grace expiry.~~
  **shipped S275** (`src/jobs/leaseLifecycle.test.ts`, 21 cases —
  moveInBundle prorate + fees + deposit + idempotency,
  generateInvoices monthly + catch-up + idempotency + fees + end_date
  clamp, generateLateFeesForTimezone happy + cap + idempotent +
  percent + grace). Caught a real prod bug:
  `fn_invoice_late_fee_subtotal_rollup_single(integer)` signature
  mismatched `invoices.id uuid`, so the trigger threw on every
  late-fee insert. Fix migration
  `20260514103000_fix_late_fee_rollup_uuid_signature.sql`.
  **S285 added session-2 extensions:** utility line-items branch
  (S178), sublease branch (S247), monthly fee accrual happy +
  idempotent + skip-zero (`monthlyFeeAccrual.test.ts`, 3 cases),
  platform fee accrual landlord/tenant payer + floor + idempotent
  (`platformFeeAccrual.test.ts`, 4 cases), scheduler-init cron
  registration smoke (`scheduler.smoke.test.ts`, 1 case).
  **S286 added:** short-stay-nights branch + cancelled-bookings
  exclusion (`platformFeeAccrual.test.ts` now 6 cases) and
  `fireManagerTransfersForReference` test surface
  (`stripeConnectTransfers.test.ts`, 4 cases: happy / no-Connect /
  Stripe-error → admin notification / idempotent). Total apps/api
  at 127 / 127.
- ~~ACH retry cron (`services/achRetry.ts:processAchRetries`): daily
  walks `payments` with `next_retry_at <= now`, fires
  `stripe.paymentIntents.confirm`, bumps retry_count, surfaces
  failures to admin notifications.~~ **shipped S276**
  (`src/services/achRetry.test.ts`, 8 cases). Completes the rent
  intake retry surface: schedule (S271) → fire (S276).

### CI / CD

~~No `.github/workflows/`. Every change relies on local
`tsc --noEmit`. Build + tsc + test run on every push.~~
**shipped S269** (`.github/workflows/ci.yml`). Postgres 16 service
container, single sequential job: `npm ci` → build
`packages/shared` → `tsc -b` apps/api → `npm test` apps/api →
`tsc --noEmit` apps/pos → `npm test` apps/pos. Triggers on push +
PR. Workflow exists locally; first remote run lands the next time
Nic pushes.

### Deploy configuration

No Dockerfile, no render.yaml, no fly.toml, no vercel.json. Need to
pick a host and write the deploy config.

Common picks for this stack:
- **Render** — managed Postgres + workers + cron service in one
  place; cheapest path to production for a Node + Postgres app. ~1
  session to wire.
- **Fly.io** — Postgres-on-fly, multi-region capable, more control.
  Slightly more setup. ~1-2 sessions.
- **Railway** — comparable to Render, less mature.

### Production cron runner

`node-cron` runs in-process inside the API (`apps/api/src/jobs/scheduler.ts`).
A restart loses all pending firings until the next scheduled time.
Works in dev; fails in production at any uptime past hours.

Options:
- Dedicated background worker process (Render/Fly worker) running
  the same scheduler module.
- Managed cron service (Render Cron, GitHub Actions scheduled
  workflows for less-critical jobs) calling internal endpoints.

### Database backups + disaster recovery

`scripts/dump-schema.sh` is schema-only — no data backup strategy
in repo. Production needs daily snapshots + PITR for financial data.
Most managed Postgres providers include this; depends on host pick.

### Stripe live-mode activation

Platform agreement signed (per Nic). Operational steps remain:
- Switch `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` from test
  to live values.
- Register the production webhook endpoint in the Stripe live
  dashboard pointing at `<prod-host>/webhooks/stripe`.
- Confirm Connect Express is enabled on the live account (should be
  already given the agreement; verify in the live dashboard).
- Set `VITE_STRIPE_PUBLISHABLE_KEY` to `pk_live_*` in every frontend
  app's production build env.

~1 session of config work.

### Resend domain verification

`EMAIL_FROM=onboarding@resend.dev` is the Resend playground sender.
Production needs a verified sending domain (SPF + DKIM + DMARC).
~30min setup + ~24h DNS propagation.

### ~~Legal documents~~ — shipped S291

ToS (`legal/TERMS_OF_SERVICE.md`, ~5,150 words, 23 sections) and
Privacy Policy (`legal/PRIVACY_POLICY.md`, ~3,910 words, 14
sections + CCPA category appendix) drafted to Nic's directives —
Delaware governing law, AAA arbitration in Wilmington + class
action waiver + 30-day opt-out, liability cap = platform fees
paid in 90 days before claim event (processing/banking/3rd-party
fees explicitly excluded; never recoverable), refund posture (GAM
refunds nothing for services rendered; landlord refunds tenants
at discretion; GAM-custody deposits via deposit-return flow),
indefinite-retention privacy posture with deletion only when
legally compelled. Engineering scaffolding:

- Migration `20260515110000_user_legal_acceptance.sql` —
  `users.accepted_tos_at` + `accepted_privacy_at`. Applied.
- `apps/marketing/server.js` — adds `/terms` and `/privacy`
  routes that render the MD files via marked, wrapped in a
  dark/gold-themed HTML template matching the landing-page
  aesthetic. Inter-doc links auto-rewritten to `/terms` /
  `/privacy`.
- `auth.ts` `/register` + `/register-prospect` + `tenants.ts`
  `/accept-invite` — require `acceptedTerms: true`; INSERT or
  UPDATE stamps both timestamps to NOW().
- Frontend gates on landlord `RegisterPage`, tenant
  `BackgroundCheckPage` (step 4) + `AcceptInvitePage`,
  pm-company `RegisterPage`. The pm-company page also had a
  pre-existing bug (snake_case + missing role) fixed under
  fix-it-right.

Lawyer review of the arbitration + limitation-of-liability
clauses recommended before broad public rollout — Claude-drafted
risk-allocation text most often fails when actually challenged
in state court. Soft-launch with a known tester is fine without
the review.

### Authentication hardening

- Rate limiting: shipped (`express-rate-limit` in
  `apps/api/src/index.ts` at 200/15min global, 100/15min auth-path).
- ~~Password reset flow: needs verification it exists end-to-end.~~
  **S277 audit confirmed it didn't exist; backend shipped S279.**
  `POST /api/auth/forgot-password` mints a 32-byte hex single-use
  token (1h TTL) and emails a reset URL; always returns 200 to
  avoid account enumeration. `POST /api/auth/reset-password`
  consumes the token, bcrypt-hashes the new password, and clears
  the token. Forces fresh login after reset (no auto-sign-in).
  Tests: 9 cases (`src/routes/passwordReset.test.ts`). **Frontend
  shipped S289 (tenant portal):** `ForgotPasswordPage.tsx` +
  `ResetPasswordPage.tsx` wired at `/forgot-password` +
  `/reset-password`. "Forgot password?" link added to LoginPage.
  Multi-portal expansion deferred — tenant pages handle reset
  for users from any portal since the backend doesn't gate on
  origin. Browser smoke check pending Nic walkthrough.
- ~~Per-account login lockout.~~ **shipped S280.** 5 failed attempts
  → 15-minute lockout. Schema: `users.failed_login_count` +
  `users.locked_until` (migration
  `20260514110000_user_login_lockout.sql`). Lockout gate runs BEFORE
  bcrypt.compare so a correct password during the window stays
  denied. Cleared by successful login, password reset, or window
  expiry. Tests: 7 cases (`src/routes/loginLockout.test.ts`).
- ~~Tighter rate-limit on /login specifically.~~ **shipped S282.**
  10 attempts per 15 min per IP on POST /api/auth/login (stacks on
  the existing 100/15min for /api/auth/*).
  `skipSuccessfulRequests:true` so good logins don't count.
  Complements the per-account lockout (S280): one defends against
  attacks on a single account, the other against attacks from a
  single IP across many accounts.
- ~~Password complexity bump (8 → 12 + classes).~~ **shipped S282
  (length only).** `registerSchema` and `resetPasswordSchema` now
  require `min(12)`. Composition classes intentionally skipped —
  NIST SP 800-63B steers away from them in favor of length, because
  composition pushes users toward predictable patterns
  ("Password1!") that don't help against modern attacks. Existing
  test passwords bumped where needed.
- ~~Boot-time JWT_SECRET validation.~~ **shipped S280.**
  `apps/api/src/lib/validateEnv.ts` throws `EnvValidationError` at
  boot when required vars are missing; warns on optional-but-
  expected vars (Stripe, Resend, DB_PASSWORD). Called from
  `src/index.ts` before app construction. Tests: 2 cases
  (`src/lib/validateEnv.test.ts`).
- ~~Email verification gate at login (column existed in schema, never
  enforced).~~ **shipped S281.** Register/register-prospect mint a
  64-char hex `email_verify_token` and fire `sendEmailVerification`
  post-commit. `POST /api/auth/verify-email` consumes the token
  (single-use, no TTL — spam-folder tolerance > security gain).
  `POST /api/auth/resend-verification` (anti-enumeration response) is
  the user-facing recovery path. Login refuses unverified users
  AFTER bcrypt (so wrong-password still gets generic "Invalid
  credentials") and auto-fires a fresh verification email. Soft
  gate: register still issues a 7d JWT for the just-registered
  session — fully strict gating ("no JWT until verified") is a
  future tightening. Tests: 12 cases
  (`src/routes/emailVerification.test.ts`). **Frontend shipped
  S289 (tenant portal):** `VerifyEmailPage.tsx` wired at
  `/verify-email`; auto-submits the token on mount; success → Sign-in
  CTA, error → "request a fresh link by trying to sign in" guidance.
  Multi-portal expansion deferred (same rationale as password
  reset).
- ~~`email_verified_at` audit column.~~ **shipped S284.** `users`
  gains a `timestamptz NULL` column, populated atomically with
  the `email_verified=TRUE` flip in `/verify-email`. No backfill —
  pre-S284 verified accounts keep NULL. Migration:
  `20260514130000_user_email_verified_at.sql`. Test extension in
  `emailVerification.test.ts` (happy-path now asserts the stamp
  lands within 60s of the verification call).
- ~~2FA: not in codebase. Decide if required pre-launch.~~
  **shipped S288 (backend).** TOTP via otplib v12 (RFC 6238 — works
  with Google Authenticator / Authy / 1Password / any compliant
  app). Schema: `users.totp_enabled` / `totp_secret` /
  `totp_enrolled_at` + `user_totp_recovery_codes` table (10
  single-use bcrypt-hashed codes per user). Four endpoints under
  `/api/auth/totp/`: enroll-start, enroll-confirm, disable,
  verify. /login mints a 5-min `totp_session` JWT
  (`purpose: 'totp_pending'`) instead of the full session
  when TOTP is enabled; client trades it at /verify for the
  full token. `MANDATORY_TOTP_ROLES = {admin, super_admin}`
  at launch — login response sets `mustEnrollTotp: true` for
  users in those roles without TOTP; landlord + pm_company
  optional-with-prompts; tenant fully optional. (The admin-ops
  portal is gated by the same admin + super_admin roles; no
  separate `admin_ops` user role exists, despite earlier S288
  handoff text claiming otherwise — caught + corrected S290
  follow-up.) Migration: `20260514150000_user_totp_2fa.sql`.
  19 tests (`src/routes/totp.test.ts`, including 5 /me cases
  for the totpEnabled + mustEnrollTotp matrix). **Frontend shipped S290 (admin
  portal only):** multi-step LoginPage (credentials → TOTP
  code), TotpEnrollPage (QR + 10 recovery codes + ack
  checkbox + confirm), MustEnrollTotpGate that forces the
  enrollment flow for `mustEnrollTotp` users before any
  authenticated route. /api/auth/me extended to return
  `totp_enabled` + server-computed `mustEnrollTotp` so the
  auth context survives page refresh. admin-ops / landlord /
  pm-company / tenant portals follow the same pattern;
  deferred to subsequent passes.
- ~~JWT expiry + refresh strategy: verify tokens don't live forever.~~
  **S277 audit confirmed.** `expiresIn: '7d'` on every sign site;
  `/api/auth/refresh` mints a fresh token from any valid one;
  verify path uses `JWT_SECRET!` (fails closed if env unset).

---

## Important for launch (should have to scale safely)

### Error tracking

**apps/api shipped S273.** `@sentry/node` v8 with auto-instrumentation,
`apps/api/src/instrument.ts` runs first, `setupExpressErrorHandler`
mounted after routes / before custom errorHandler. No-op without
`SENTRY_DSN` (every call short-circuits to nothing — keeps dev +
tests clean). 4xx auto-filtered via beforeSend; 5xx + uncaught
exceptions land in Sentry when DSN is set.

**Frontend coverage shipped S291.** `@sentry/react` ^8.55.2 added
to 9 React apps (admin, admin-ops, books, landlord, listings,
pm-company, pos, property-intel, tenant). Each has its own
`src/lib/sentry.ts` with identical posture: init guarded on
`VITE_SENTRY_DSN`, `beforeSend` filters 4xx (axios `err.response.status`
+ raw `err.statusCode`), `sendDefaultPii: false`, tracing off
(flip on via `browserTracingIntegration()` later if launch quota
allows). Each `main.tsx` wraps the root render with
`<SentryErrorBoundary>`. Landlord's pre-existing inline
ErrorBoundary kept (inner recovery for non-fatal errors); Sentry
sits outside it. `VITE_SENTRY_DSN` / `VITE_SENTRY_RELEASE`
documented in `.env.example`. Marketing app (static HTML) skipped
intentionally. To enable in prod: set `VITE_SENTRY_DSN` per portal
deploy env before `vite build`.

### Structured logging

**Infra shipped S274.** `apps/api/src/lib/logger.ts` exposes a
process-wide pino instance (`logger`) + a pino-http middleware
(`httpLogger`) that attaches `req.log` to every request with a
generated/forwarded X-Request-Id. Morgan removed. Pretty
output in dev, raw JSON in prod, quiet in test. errorHandler
logs 5xx via the per-request child logger.

**Hot paths migrated S283** (~143 sites): webhook handler
(`routes/webhooks.ts`), cron scheduler (`jobs/scheduler.ts`),
all 13 cron job files. allocation engine was already
console-free pre-migration. Logs in these surfaces now emit
structured JSON in prod with `payment_id` / `stripe_*` /
`event_type` etc. as queryable fields. Side fix: a backslash-
escaped template literal in scheduler.ts tz-cron-refresh
summary that was emitting literal `${info.label.padEnd(22)}`
instead of interpolated values.

**Cold paths migrated S287** (~129 sites across 40 service /
route / lib files). Bare console.\* → logger.\* rename + a
structured-form pass that converts the common
`logger.X('msg', err)` and `logger.X('msg', id, err)`
patterns to `{ err, ctx }, 'msg'` form so pino's err
serializer captures the stack trace. `lib/logger.ts` exports
a type-widened `logger` so residual printf-style outliers
type-check without per-site rewrites. CLI scripts
(`db/migrate.ts`, `db/seed.ts`) intentionally preserved on
`console.*` for human-readable ✓/✗/🌱 stdout output. Zero
active `console.\*` call sites remain outside those two
files.

### Frontend monitoring

No PostHog / Amplitude / Mixpanel. Zero visibility into user
behavior, funnel completion, feature usage.

### ~~Landlord onboarding — CSV imports from PM softwares~~ — shipped S291

End-to-end migration story is live across 3 CSVs:

1. **Properties + Units** (Phase A) — `PropertyOnboardingPage` at
   `/property-onboarding`. Endpoints `POST /me/onboard-properties-csv/
   {validate,commit,template}`. One row = one unit; property find-or-
   created on `(name, street1)`. Each new property gets a default
   `property_allocation_rule` (tenant/tenant/landlord payers).
2. **Tenants + Leases** (pre-existing S231 + S291 enhancements) —
   `outstanding_balance` added to tenant canonical headers + per-platform
   mappings. Commit writes a pending opening-balance invoice for any
   positive value. Misleading "coming soon" copy on TenantOnboardingPage
   fixed.
3. **Payment History** (Phase B) — `PaymentHistoryOnboardingPage` at
   `/payment-history-onboarding`. Endpoints `POST /me/onboard-payment-
   history-csv/{validate,commit,template}`. Migration
   `20260515090000_payments_import_source.sql` adds `payments.import_source`
   + `imported_at`. Email-based tenant→lease resolution with ambiguity
   handling (multi-active-lease tenants disambiguated via
   property_name + unit_number). Negative amounts and unknown
   payment_type strings blocked. Commit writes `payments` rows with
   `status='settled'`, `import_source=<platform>`, `settled_at=payment_date`.

**Mapping registry** in `apps/api/src/lib/csvImportMappings.ts` covers all
8 platforms (Buildium, AppFolio, DoorLoop, Yardi, RentManager,
Propertyware, Rentec Direct, TenantCloud) across all 3 CSV types. S291
research rounds verified HIGH-confidence column names and fixed real
gaps:

- AppFolio property addresses → `Unit Street Address 1/2`, `Unit City`,
  `Unit State`, `Unit Zip`, `Unit ID`, `Unit Type` (was silently dropping
  every AppFolio address before this).
- AppFolio tenants → `Emails` (plural, comma-separated), `Phone Numbers`
  (plural), bare `Move-in`/`Move-out`.
- Propertyware → `Home Phone #` / `Mobile Phone #` / `Work Phone #`
  (literal `#`), `Unit Address`, `Unit Address Cont.`.
- Buildium tenants → `Login email`, bare `Mobile`. Buildium properties →
  `Unit address line 1/2`, `Street Address line 1/2`, `City/Locality`,
  `State/Province/Territory`, `Postal code`, `Sub type`, `Unit number`.
- RentManager properties → `Street1` / `Street 1`, `Street2` / `Street 2`,
  `PostalCode` (concatenated).
- Buildium line-3 address (`Unit address line 3`) intentionally dropped —
  no third street slot in `properties`, concatenation would risk
  malformed output.

**Test coverage** in `src/lib/csvImportMappings.test.ts` (35 cases),
`src/routes/csvImportProperty.test.ts` (14), `src/routes/csvImportTenantBalance.test.ts`
(9), `src/routes/csvImportPaymentHistory.test.ts` (13). All 217 tests
pass.

**Still unproven against real exports.** Mappings are built from
documented column lists + verbatim transcriptions in RentCheck's
template docs. S292 added DoorLoop + Square real-export verification.
S293 added a public-source research pass against Yardi / Rentec /
TenantCloud (no real customer exports — trial signups explicitly
ruled out by Nic). Findings firmed up Rentec property fields from
its open help center (`Nickname` / `Square Footage` / `Default Rent`
/ `Default Security Deposit` / `Year Built` / `Overdue`),
TenantCloud Q2 2025 column changes (`Start Date` / `End Date` /
`Deposits held` / `Money In` / `Available on`), and Yardi long-
form date variants (`Lease From Date` / `Lease To Date` / `Move-In
Date`) verified against TenantTech's published integration spec.

**Two follow-ups carried forward from S293 research:**

1. **Yardi GL-style export columns** — distinct from rent-roll
   exports. Boston Post's Yardi integration docs name verbatim
   columns `Transaction Number` / `Posting Date` / `Posting Month`
   / `Batch Memo` / `Class Code` / `Amount`. Critically: Yardi's
   GL export does NOT carry payment_method (lives on the receipt
   header in Voyager but not in the GL export). Surface this as
   a real migration limitation if a landlord shows up with Yardi
   GL data instead of rent-roll receipts. Not wiring it now —
   different export shape, lower likelihood than receipt format.
2. **Rentec import template (`Import-Properties-and-Tenants.xlsx`)
   is gated behind Rentec login.** Public help docs covered most
   of the property side but the actual canonical Rentec import
   columns remain LOW-confidence until a real Rentec customer
   surfaces. If one shows up, ask them to upload the blank
   template — fastest path to firm Rentec coverage.

Highest-likelihood next miss when a real migration happens:
Yardi (heavily user-customized rent rolls — every Voyager
implementation can name columns differently) and TenantCloud
(drag-and-drop column selection in every report means TC exports
are inherently inconsistent customer-to-customer; consider a
column-mapping step in the import UI specifically for TC).

### Vendor go-lives still pending

- **Plaid / Financial Connections** — tenant ACH verification flow
  needs production Plaid keys.
- **Stripe Terminal** — POS card-present needs production hardware
  + production Stripe Terminal access (separate from base Stripe;
  needs hardware acquisition + reader registration).
- **Checkr Partner** — credentials land Monday per Nic. Three known
  follow-up items staged: SSN-strip refactor, Checkr HMAC raw-body
  wiring in `index.ts`, `applicantPaymentIntentId` reconciliation.
  Single session once credentials arrive.

### Database scale + tuning

Single `pg.Pool` with default settings. Fine for early users; past
~100 active properties:
- Connection-limit tuning aligned to host's Postgres tier.
- Possibly read replicas for reporting queries (PaymentsPage list,
  pos transaction history, admin dashboards).
- Query-plan review for the heaviest joins (allocation engine,
  deposit-return calculation).

### ~~Repo hygiene cleanup~~ — shipped S288

`dev.sh.s29c2g.bak` + `package.json.s56.bak` deleted at repo
root. The `apps/api/src/routes/*.s*backup` files were already
gone from the working tree (git showed them as `D` un-staged
but the disk state was clean).

---

## Post-launch — Flex Suite backend testing (when flags flip on)

These battle-tested at scale before any Flex flag flips on for
real users. The supersedence engine + FlexDeposit acceleration +
FlexCharge merchant flow are sophisticated and unproven against
live tenant behavior. Build the test battery before flipping flags.

### Supersedence engine (S261)

- FIFO ordering across all 5 sources (FlexDeposit defaulted
  installments + accelerated balance + FlexCharge statements +
  FlexPay advances + custody charges).
- Boost cap at min(amount, outstanding). Self-subtract for
  pulls targeting their own debt class.
- `applyTenantSupersedence` idempotency via
  `gam_supersedence_applied_at`.
- Residual handling when boost > live FIFO total at settle
  (debt shrunk between PI create and webhook).
- Allocation engine subtraction from `allocation_owner_share`.
- FlexCharge merchant Transfer post-commit firing.

### FlexDeposit acceleration (S260)

- 2-strike machinery: installment defaults → consecutive-default
  check → acceleration fires.
- Primary pull (rent_due−5) → retry pull (rent_due−1) →
  installment defaulted on 2nd failure.
- `accelerateFlexDepositPlan` → settled/failed webhook routes.
- S262 manual retry from `in_default` state
  (`retryFlexDepositAcceleration`).
- Lease-end disbursement when plan still in_default
  (collected_amount < total_amount edge case).

### FlexCharge end-to-end (S252-S259)

- Monthly statement generation cron.
- Statement billing ACH pull → webhook settle → merchant Transfer
  to landlord.
- Dispute lifecycle (tenant in-app dispute → 3-in-90-days landlord
  cutoff).
- POS sale with `paymentMethod='charge'` → account capacity
  check → transaction posted.

### FlexPay coexistence with OTP (S245)

- Grace-end front-Transfer to landlord.
- Tenant-side ACH pull on chosen day.
- OTP coexistence dedup (no double-pay).
- 2-NSF default → 60-day suspension.

### FlexCredit

~5% built (single boolean column + flip endpoint). Vendor-blocked
on CredHub + Esusu integration. Product semantics need a call
before further code: which bureaus to report to, what events
qualify (rent-paid? rent-late?), $5/mo billing model finalization.

---

## Feature backlog (small / deferred for post-launch)

### POS multi-terminal sync — Session 3 (SSE realtime push)

Polling-on-tab-refresh covers cross-terminal pickup at 2-terminal
max. SSE worthwhile when online customer-built carts (20+
simultaneous, per S263 scoping) ship or multi-staff cart
collaboration becomes a real workflow.

Scope when it lands:
- `GET /pos/sessions/stream?property_id=...` SSE endpoint pushing
  session-mutation events.
- Frontend EventSource hooks into the stream; patches react-query
  cache + reconciles local sessionItem rows.
- Heartbeat (15s) + reconnect-on-drop + auto-cleanup of stale
  streams (idle > 5min).

### Tenant-pool endpoint refinements

S177: scope TBD. Needs Nic to flag specific concerns on
walkthrough.

### Smaller items

- End-to-end smoke walks (POS sale → inventory → PO → restock,
  `/resolve` flow) — Nic-initiated only per project rules.

---

## Nice-to-have post-launch

- Mobile responsiveness audit on all portals.
- Accessibility (WCAG-AA) audit.
- Performance / load-testing baselines.
- Customer-support infrastructure (help docs, support email routing,
  ticket system).
- Multi-region disaster recovery.
- Data export / GDPR + CCPA compliance flows (subject access
  requests, deletion).
- Admin "kill switch" for vendor outages (degrade gracefully if
  Stripe or Plaid is down).

---

## Vendor-blocked (waiting on outside parties)

- **Plaid production keys** — tenant ACH verification live mode.
- **Stripe Terminal production access + hardware** — physical
  reader provisioning for POS card-present.
- **Resend domain auth** — ~24h DNS propagation after submit.
- **Checkr Partner credentials** — unblocks Monday per Nic.

(Stripe Connect platform agreement: already signed, not blocked.)

---

## Suggested launch order

1. Pick a host (Render is fastest path).
2. Wire deploy config + production cron runner.
3. ~~Write critical-path tests~~ **shipped (S265–S333, 618 tests / 32 files).**
4. Domain + DNS + SSL + Resend domain auth.
5. ~~Error tracking (Sentry) on API + all frontends~~ **shipped S273 / S291.**
6. ~~Legal docs drafted~~ **shipped S291; lawyer review still recommended
   before broad public rollout.**
7. Stripe live keys + production webhook URL registered.
8. Database backup + PITR verification on host.
9. ~~Repo hygiene cleanup~~ **shipped S288.**
10. Soft-launch to N=1 landlord (Nic or known tester) on live
    Stripe with Flex flags off.
11. Vendor go-lives as they unblock (Plaid live, Checkr partner,
    Stripe Terminal hardware).
12. Wider rollout.
13. **Post-launch**: backend battery on Flex Suite + supersedence,
    then flag-by-flag rollout of each Flex product.

**Remaining launch blockers** are all vendor / dev-team / Nic-pending:
host pick → deploy → Stripe live keys → Resend domain → Plaid keys →
Checkr credentials → Stripe Terminal hardware. Test thread is closed.
