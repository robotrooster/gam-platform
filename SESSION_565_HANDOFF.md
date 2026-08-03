# SESSION 565 HANDOFF

**Theme:** Built the S564-designed **sales-tax + economic-nexus workstream** end to
end (research → code). Two-layer screening-tax collection catalog with a
registration gate, a 50-state economic-nexus threshold catalog, a nightly
revenue-tally service + cron, and a super-admin **Nexus Monitor** dashboard.
All UNCOMMITTED (alongside the still-uncommitted S557–S564 batch). Nothing here
is an Aug 1 launch blocker — it's the "register early, collect narrowly" tax
machinery, dormant until Nic registers a state.

---

## What shipped (all typecheck-clean; 59 focused tests green)

### 1. Screening-tax collection catalog — migration `20260729100000`
- **`state_screening_tax_rates`** (state, effective_year, taxable, rate_pct,
  basis, status research|confirmed, source, notes). 50 states + DC seeded for
  2026. **7 taxable** (TX 6.25, SD 4.2, HI 4.0, NM 5.0, CT 6.35, DC 6.0, WV
  6.0), all `status='research'` with confidence notes; OH explicitly $0
  (FCRA-report carve-out); no-sales-tax states confirmed $0; everything else $0
  research. **Tax base = the screening line only** (`basis='screening'`) — the
  GAM margin (SaaS) and card processing are separate untaxed lines. (SaaS/
  platform-fee taxability = a separate future map, ~20 states — NOT built.)
- **`state_tax_registrations`** (state_code PK, registered, registered_date,
  source manual|nexus_auto, notes). The operational gate. **Empty today →
  collects $0 in all 50 states, zero risk.**
- **Collection rule: tax = rate × base ONLY IF (taxable AND registered).**

### 2. State-aware screening fee — `routes/background.ts`
- `screeningIntakeFee(applicantState?)` is now **async + state-parameterized**
  (was sync, `tax=0` hardcoded). New `screeningIntakeTax()` helper does the
  gated catalog lookup (latest effective_year ≤ current, honors `basis`,
  registration-gated). Now **exported** for tests.
- Threaded applicant state through both call sites: `POST /background/payment-
  intent` (reads `req.body.state`) and `POST /background/submit` (has `state`).
  Payment-intent + submit use the same state so the verify-amount always
  matches. With 0 registrations, tax=0 everywhere → no mismatch risk.
- ⚠️ **Item 10 (the client card step, S564) still not built** — when it's wired,
  the client must send `state` to `/payment-intent` so the quoted tax matches
  what `/submit` re-verifies. (Moot until a state is registered.)

### 3. Economic-nexus threshold catalog — migration `20260729110000`
- **`state_nexus_thresholds`** (state, effective_year, revenue_threshold_usd,
  txn_threshold, count_rule or|and|revenue_only, measurement_period, status,
  source, notes). 50 states + DC. Revenue figures = well-known Wayfair numbers
  (CA/TX/NY $500k, AL/MS $250k, rest $100k; DE/MT/NH/OR NULL = never register;
  AK = ARSSTC local $100k). Txn-count is research-grade + nullable (many states
  repealed it). NY seeded `count_rule='and'` ($500k AND 100 txns); CT 'and' too.

### 4. Nexus tally service + nightly cron — `services/nexusMonitor.ts`
- `recomputeNexusTally()` — sums **GAM's OWN revenue by CUSTOMER state**, current
  + prior calendar year, into **`nexus_revenue_tally`** (migration
  `20260729120000`). Sources: platform_fee_accruals (by property state),
  screening_fee_accruals (by applicant state, gross = standard_total),
  business_platform_fee_accruals (by business state), flexpay_advances (by
  unit/property state). **Excluded:** rent, POS sales (GAM ≠ marketplace
  facilitator), payouts, and **`monthly_fee_accruals`** (legacy platform-fee
  table — excluded to avoid double-count vs platform_fee_accruals).
- `getNexusDashboard()` — read model: measure = **max(current YTD, prior year)**
  (conservative); status = crossed / approaching (≥80% warn) / under /
  registered / no_threshold, honoring count_rule. Registered **wins over**
  crossed.
- `setStateRegistration()` — upserts the registration gate (turns collection
  on/off).
- **Cron: nightly 3:20am** in `jobs/scheduler.ts` (after the 3am jobs).
- All source tables are **empty in dev** today, so the tally is 0 rows / all
  states "under" — correct, not a bug (verified source counts = 0).

### 5. Admin Nexus Monitor dashboard — `apps/admin/src/main.tsx`
- New super-admin route `/nexus` + nav link "🗺️ Sales-Tax Nexus" (Compliance
  section). Dark/gold theme. Summary KPIs (crossed/approaching/registered/under),
  crossed-state alert, per-state table with **progress bars toward threshold**
  (green→amber→red), taxable badge, and a **Register/Unregister** action behind
  an **in-app confirm modal** (no native dialog — [[gam-no-native-dialogs]]) with
  date + notes. "↻ Recompute tally" button.
- Endpoints in `routes/admin.ts` (all `requireSuperAdmin` + audited):
  `GET /admin/nexus/dashboard`, `POST /admin/nexus/recompute`,
  `POST /admin/nexus/register`.
- **GOTCHA fixed:** `admin_action_log.target_id` is UUID — first pass put the
  state code there → logAdminAction silently swallowed the error (best-effort
  try/catch), audit row never wrote. Moved state into `metadata`. Test caught it.

### Tests (59 green): `services/nexusMonitor.test.ts` (12) — tax gate (0 unless
taxable AND registered; basis handling; rounding), dashboard status logic (all 5
statuses, count_rule and/or, registered>crossed, max(cur,prior)), recompute
aggregation, registration flip. `routes/admin-nexus.test.ts` (5) — super_admin
gating, dashboard shape, register+audit, recompute, bad-state reject. Plus
admin.test.ts (12) + background- (30) unaffected.

---

## Verification done
- API + admin **typecheck clean**. `npm run build` (api) clean. Prod API
  **rebuilt + safe-restarted** (health 200) — route live, scheduler w/ new cron
  loads. Admin bundle serves under Vite with **zero console errors**.
- Migrations applied to dev `gam` (schema.sql regenerated). Catalog sanity:
  tax 51 / nexus 51 / registrations 0 / tally 0.
- **Not** visually smoke-walked past login — the `/nexus` page is super_admin +
  hard-enforced TOTP, which can't be driven headlessly. That's Nic's UI smoke.

---

## OPEN QUESTIONS / decisions for Nic
1. **Nexus counts SCREENING at GROSS (standard_total), not GAM's $5 margin.**
   Rationale: economic nexus is measured on gross receipts into a state, so
   gross is both conservative (register earlier) AND legally correct for the
   nexus trigger — while *collection* still taxes only the narrow screening base.
   This resolves the S564 "gross vs margin" ambiguity in favor of gross for the
   TRIGGER. Flag if you want margin-only instead.
2. **Local/county surtaxes not modeled** (TX/SD/NM +local, HI Oahu surcharge) —
   only state base rate. Add a local layer only if a registered state needs it.
3. **The 7 taxable rows + all thresholds are `status='research'`.** Before
   registering/collecting anywhere, a tax pro should confirm (esp. CT/DC/WV/TX
   — is an individual buying their OWN FCRA report a taxable service?).

## Still on the S564 renter-pool remaining list (NOT this session)
Items 10 (client card step), 11 (gated pool-applicant portal), 12 (marketing +
QR entry points), 14 (neutral-status pool display + admin assignment), 15
(is_system exclusion sweep), 16 (e2e speculative→shell test). Checkr still on
mock; live keys Nic self-generates. See SESSION_564_HANDOFF.md.

## Owner account + EMAIL-CODE 2FA (S565, built same session — uncommitted)

Nic wanted a real, persistent highest-level login (stop the per-session
force-login shuffle) with **email-code 2FA, NOT an authenticator app**.

- **Owner account created:** `nic@golddoor.io` / `GoldOwner2026!`, role
  **super_admin**, `email_2fa_enabled=true`, `totp_enabled=false`,
  email_verified. Script: `apps/api/src/scripts/mintOwnerLogin.ts` (idempotent;
  also mints a session token for direct injection).
- **New feature — email-code 2FA** (alternative second factor to authenticator
  TOTP for admin/super_admin):
  - Migration `20260729130000`: `users.email_2fa_enabled` + `login_email_otps`
    (bcrypt-hashed 6-digit codes, 10-min TTL, one active/user, attempts cap 5).
  - `routes/emailOtp.ts`: `issueEmailOtp()` + `POST /api/auth/email-otp/verify`
    + `/resend`; pending session token `purpose:'email_otp_pending'` (rejected by
    requireAuth everywhere else, same guard as TOTP-pending).
  - `services/email.ts`: `emailLoginCode()`.
  - `routes/auth.ts /login`: precedence = **totp_enabled → email_2fa_enabled →
    (mandatory role) force TOTP enroll**. Email 2FA SATISFIES the mandatory-2FA
    requirement (`mustEnroll` now also `&& !email_2fa_enabled`; fixed `/me` to
    SELECT + return the same — it was omitting the column → false "enroll TOTP").
  - Admin `LoginPage`: email-code step (mirror of TOTP step) + resend; `useAuth`
    `loginWithEmailOtp` + `resendEmailOtp`.
  - Mounted at `/api/auth/email-otp` in `index.ts`.
- **Verified live e2e:** login → `requiresEmailOtp` + code emailed (Resend) →
  verify code → full super_admin session → nexus dashboard 200; `/me`
  `mustEnrollTotp:false`. Tests: `routes/emailOtp.test.ts` (7) + auth suite (35)
  green. Real code goes to nic@golddoor.io's inbox.
- **⚠️ Prod note:** the launchd API (`com.gam.api`) was running a **Jul-26**
  build all session — earlier "restarts" never cycled it (kill hit the wrong
  pid). Correct restart = `launchctl kickstart -k gui/$(id -u)/com.gam.api`. Now
  running today's build. Both S565 features are live on dev-prod :4000.

## Launch state (unchanged)
Only launch blocker = live Stripe cutover (C4 live-fire + C5 prod walkthrough) +
Nic's data entry (N2/N3/N4). This session's tax/nexus work is post-launch
machinery, dormant (0 registrations) until Nic acts. All S557–S565 work remains
UNCOMMITTED.
