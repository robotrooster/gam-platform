# SESSION 567 HANDOFF

**Theme:** Big product/UX session on top of S566. Built the **portfolio-manager
commission system** (dual-role attribution + referral keys + accrual engine +
pot) and **scoped the admin portal** so a regular admin is a scoped portfolio
manager. Then a walkthrough-driven cleanup sweep: **removed Bulletin Board**
entirely, **locked System Features to the owner account**, **ripped all
tenant-facing On-Time Pay out of the system** (OTP is landlord-only, shelved,
owner-gated), and **decluttered the admin nav**. All UNCOMMITTED. Everything
typecheck-clean; API rebuilt + live on :4000 throughout.

Read alongside `SESSION_566_HANDOFF.md`.

---

## Shipped this session (all typecheck-clean, tested where noted, LIVE)

### 1. Reserve page fixed (the S566 loose end)
Standalone admin `/reserve` still showed the OLD model (phases, `activeUnits×$600
×rate×3mo`, 4.5% APY). Rewrote to match the Overview: reserve target = **3% of
the FlexPay float**, bankroll = income-verified (approved-inquiry) FlexPay
tenants, no phases, no yield until ODFI. Dropped dead `getReservePhase`/
`RESERVE_CONFIG` imports.

### 2. Portfolio-manager commission system (the big build)
Memory: **[[gam-portfolio-manager-comp]]**. Per OCCUPIED unit/month:
- **Closing 25¢ + Customer-service 25¢ = 50¢ to the closing agent** (does own
  CS), recurring forever while the landlord stays. NOT splittable EXCEPT a
  self-closed landlord (organic, no closer): closing 25¢ → POT, CS 25¢ → an
  assigned CS-specialist PM. **CS is never orphaned, never pots.**
- **Flat 10¢/occupied unit → POT always** (not commission). Pot = 10¢-always +
  orphaned closing-25¢ only.
- Occupied = `units.status <> 'vacant'`.
- **Referral keys**: reps AND landlords get `users.referral_code`. Landlord B
  signs up with landlord A's code → A is the CLOSER (25¢ residual, same as a PM
  closer); CS breaks to a PM (landlord can't do platform CS — the one clean
  split). Signup disambiguates by code owner's role (admin/super → closer;
  landlord → `landlords.referred_by_user_id`). `?ref=` captured on landlord
  RegisterPage.
- **Attribution model**: whoever CLOSES owns it. `landlords.portfolio_manager_id`
  = closer (referral key at signup OR super_admin assign — NOT self-claimable),
  `landlords.service_manager_id` = CS. Landlords self-register (auth.ts is the
  only creation path), so attribution is assign/claim, not auto-stamp.
- **Accrual engine**: `jobs/commissionAccrual.ts` (monthly cron `45 1 1 * *`),
  idempotent per (landlord,month,role) via ON CONFLICT. `commission_accruals`
  table. Manual run: `POST /admin/commissions/accrue` (super). **7 accrual tests
  green.** Rates: shared `PORTFOLIO_COMMISSION` (CLOSING/SERVICE 0.25, POT_ALWAYS
  0.10, CLOSER_TOTAL 0.50).
- **PAYOUT (Nic-decided, NOT yet wired — waits on live Stripe)**: commission
  CREDITS the referrer/PM's platform-fee bill first; any SURPLUS wires as a line
  item on their existing Connect payout (rides autoPayouts, no new flow).
  Breakeven for a landlord referrer = referring ~8× their own occupied units
  (0.25×referred = 2.00×own; NOT 4×).
- **UI**: admin Commissions page (PM sees own earnings + own by-landlord; pot +
  all-manager breakdown super-only), landlord `/refer` "Refer & Earn" page
  (code + link + earnings), admin Landlords detail shows closer/CS + referral +
  super assign dropdowns. Migrations: `..200000_landlord_portfolio_manager`,
  `..210000_portfolio_manager_comp`, `..220000_commission_pot_role`,
  `..230000_landlord_referral`.

### 3. Admin portal scoping — regular admin = scoped portfolio manager
Regular `admin` sees ONLY their book (closer or CS = them). Scoped:
`/landlords` (own book only — pool removed), `/admin/tenants`,
`/admin/onboarding/overview` + Onboarding Console table (attributed-only) +
detail guards, `/units`, `/payments`, `/disbursements`,
`/admin/connect-readiness/accounts` (+banking-nudges; PM companies hidden),
`/admin/income/*`. SUPER-ONLY now (nav+route+backend): FlexPay Requests (all
`/admin/flexpay/*`), Property Reviews (`/admin/property-flags`), Leads
(`/admin/leads*`), CSV Imports, Reporting Disputes, Subleases, Deposit
Portability, Scaling Readiness, Agent Analytics. `req.user.userId` (NOT `.id`).

### 4. On-Time Pay — tenant-facing RIPPED, landlord product shelved/owner-gated
Memory: **[[gam-otp-shelved-landlord-only]]**. OTP = landlord-only rent-advance
product, landlord-paid, **NEVER tenant-facing** (Nic, hard rule). Separate from
FlexPay. **Ripped every tenant-facing artifact**: `sendOnTimePayInvitation`
email, the scheduler late-payment invite trigger, `POST /tenants/enroll-on-time-
pay`, AcceptInvitePage OTP card + SSI/SSDI block, the verify-ach "OTP qualified!"
response messages, the landlord late-payment-notice OTP line, dropped
`tenants.on_time_pay_invite_sent_at`, deleted orphaned `landlord/OtpPage.tsx`,
cleaned seed (no demo OTP-enrolled tenants). **Platform-wide frontend sweep =
empty.** Landlord product PRESERVED dormant (services/otp.ts, webhook/scheduler/
payment hooks, columns, otp_advances, ONTIMEPAY enum, migrations). Surfaces to a
human in exactly ONE place: the OWNER's System Features flag (`requireOwner`).
Landlord `/me/otp/*` endpoints flag-gated; admin OTP endpoints `requireOwner`.

### 5. Bulletin Board — completely removed
Not a feature anymore. Dropped tables (bulletin_posts/votes/reveal_log/archive),
deleted `routes/bulletin.ts`, removed admin endpoints + nav + page + route,
landlord dashboard widget, tenant UI, shared `bulletin.view` permission,
complianceArchive entry. Migration `..240000_drop_bulletin_board`. Tests fixed
(27/27 green in the touched admin suites; income test un-stale'd; income
endpoints super-gated).

### 6. System Features → owner-only
New `requireOwner` middleware + `OwnerGuard` (email === nic@golddoor.io). Nav +
route + GET + PATCH all owner-locked so no other admin can flip a feature flag.

### 7. Admin nav declutter (Nic walkthrough)
Removed nav tabs (backend/routes/components intact, URL-reachable): **CSV
Imports, Deposit Portability, Subleases**. Kept Scaling Readiness + Reporting
Disputes.

### 8. Explained (no code change)
- **FlexPay flags**: `flexpay_rollout_visible`=ON is the tenant SURVEY (demand
  test, visible/"coming soon"); `flexpay_enrollment_open`=OFF gates real
  enrollment (flip at launch). No money moves (no enrollments).
- **Agent Analytics**: counts `agent_interaction_logs` (1 row = 1 turn). The
  46 turns / 5 escalations = leftover EVAL/test data from Jul 23-24; no real
  activity since (no customers yet). Offered to clear test rows.

---

## Open / for Nic's decision (morning)
- **DATA RETENTION (Nic's requirement): keep full permanent history of every
  tenant/unit/occupancy/lease ever on the platform, even if a landlord deletes
  their side.** We do NOT need to keep the raw uploaded CSV file. Recon: core
  tables (tenants/leases/units/properties) have **no soft-delete/archive
  columns**; the one `DELETE FROM tenants` (landlords.ts:1872) is GUARDED to
  aborted pending-invites (`safeToDeleteTenant`, no history). So retention looks
  designed-in (no destructive delete path for records-with-history; move-outs are
  status changes, not deletes) — BUT this was NOT exhaustively audited. **Verify:
  confirm no landlord action can destroy tenant/unit/occupancy/lease history via
  any path (leases, units, properties deletes; cascades); if any gap, add an
  explicit archive/soft-delete layer.** Nic believes it's already designed this
  way; confirm it.
- **Full-CSV backup**: not needed per Nic (only the imported DATA must persist,
  which the retention item covers). No action unless retention audit finds a gap.
- **Agent Analytics test rows**: offered to clear the Jul 23-24 eval data so the
  tab reads zero until real traffic. Nic's call.

## Next session
- **NEXT: the retention audit above** (Nic wants certainty history is permanent).
- Then the planned **tenant portal + landlord portal final walkthroughs** (Nic
  will drive; fix UI as we go).
- Portfolio-manager commission PAYOUT wiring (credit-then-Connect-surplus) waits
  on live Stripe, same as the rest of the money flow.
- Standing launch blockers unchanged: live Stripe cutover (C4/C5) + Oak Park
  data entry (N2/N3/N4).

## Launch state
All money/comp code complete + tested; commission accrual verified end-to-end
against live demo data. Nothing committed — Nic decides push.
