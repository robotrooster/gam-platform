# SESSION 566 HANDOFF

**Theme:** Huge admin/money session on top of the S565 nexus work. Shipped the
sales-tax + nexus monitor, a real owner login with **email-code 2FA**, finished
**Connect Stage 2** (the actual launch blocker), reworked the admin dashboard
(recurring ARR vs. a wall-of-pies income composition + click-through breakdown),
fixed stale revenue math, and wired **FlexCredit** end-to-end (invisible). All
UNCOMMITTED (53 changed/new files, incl. the still-uncommitted S557–S565 batch).

Read alongside `SESSION_565_HANDOFF.md` (nexus/tax detail) — this doc is the
superset + game plan.

---

## Shipped this session (all typecheck-clean, tested where noted, LIVE on :4000)

1. **Sales-tax + nexus monitor (S565).** `state_screening_tax_rates` +
   `state_tax_registrations` (collection gate — $0 nationwide until Nic
   registers) + `state_nexus_thresholds` + `nexus_revenue_tally` +
   `services/nexusMonitor.ts` + nightly cron + admin `/nexus` dashboard. 17
   focused tests green. All rates `status='research'` — tax-pro must confirm
   before collecting.

2. **Owner account + EMAIL-CODE 2FA.** Real super_admin `nic@golddoor.io` /
   `GoldOwner2026!`. New email-OTP 2FA (no authenticator app): migration
   `email_otp_2fa`, `routes/emailOtp.ts` (verify/resend + issueEmailOtp), login
   precedence totp→email→enroll, admin LoginPage code step, `/me` fixed. 42
   tests green (7 email-otp + 35 auth). ⚠️ `mintOwnerLogin.ts` signs a token
   directly (NO email) — USE IT for dev verification; NEVER curl `/login` for
   nic@ (it emails a real code — burned ~8 before we caught it). Reusable token
   at `/tmp/gam_admin_verify_token.txt`.

3. **Connect Stage 2 — the real launch blocker, now DONE.** S554's "Stage 2
   done" was overstated: the payout cron + withdrawal route still resolved by
   USER, so an entity-anchored landlord's rent would have STRANDED. Fixed:
   `jobs/autoPayouts.ts` candidate scan + `routes/withdrawals.ts` now resolve
   `COALESCE(landlord entity, founding user)` with a live `landlord_members`
   recheck on withdrawal. 19 tests green (2 new entity-payout). **This unblocks
   N2/N4 — Oak Park KYC is now safe.**

4. **Admin dashboard rework.** Recurring **ARR** (platform + FlexPay only,
   ×12) kept clean & separate; below it a **wall of 5 pies** (This month / QTD /
   YTD / Rolling 12mo / All time) — clickable → **breakdown modal** (per-source
   count + amount + %, no raw line items). Income streams w/ colors: Platform
   (gold), Processing/ACH (blue), FlexPay (green), FlexDeposit Custody (pink),
   FlexCredit (amber), Business Fees (cyan), Placement (orange), Instant
   Withdrawals (teal), Background Checks (Ferrari-red #e10600). Nav emoji →
   grayscale lucide icons.

5. **Reserve/Float cards fixed.** Default Reserve target = **3% of the FlexPay
   FLOAT** (money at risk), not platform rent. Float Bankroll = rent of
   **income-verified** (approved-inquiry) FlexPay tenants. Removed phases +
   4.5%-APY line (yield waits for ODFI). Backend `/admin/overview` adds
   `flexpay_bankroll`.

6. **Stale revenue math fixed.** `BG_CHECK_NET` $15→**$5**, `FLOAT_FEE_MO`
   $20→**$25**, both in `PLATFORM_FEES` with source-of-truth comments. Income
   projection no longer counts one-time bg checks in recurring ARR.

7. **FlexCredit wired end-to-end (INVISIBLE / dormant behind
   `flexcredit_rollout_visible`=off).** Demand survey (`flexcredit_inquiries`,
   tenant "I'm interested" card in survey mode, admin `/flexcredit/funnel` w/
   adoption% + 100/333 breakeven thresholds) + full billing
   (`FLEX_CREDIT_FEE=5`, `flexcredit_charges` ledger, `services/flexCredit.ts`
   monthly cron mirroring custody, $5 `fee` line item, pie slice). Only the
   **Esusu provider side (payout + bureau reporting) is NOT wired** — external
   integration, needs keys like Checkr.

8. **Business slice renamed "Business Fees"** (was "Business POS" — wrongly
   implied card revenue). Commission model captured in memory
   ([[gam-business-monetization]]): commission biz (mechanic etc.) = ~5% of
   sales + card markup, waive the $10; card markup always in Processing/ACH.

**Memories written/updated:** gam-nexus-tax-catalog, gam-owner-login-email-2fa,
gam-connect-reanchor (corrected), gam-flex-product-revenue-model,
gam-business-monetization, gam-transparency-metrics-ideas.

---

## NEXT SESSION — game plan

**A. Portal walkthroughs + UI fixes (the main planned work).** Walk the
**landlord (:3001)** and **tenant (:3002)** portals; Nic compiles a UI-change
list; fix as we go. The admin dashboard (the big one) is done. Batch cosmetic
fixes, don't treat them as blockers.

**B. Final bug sweep, then GitHub push.** 53 files uncommitted (S557 → this
session). Push is Nic's call — do the sweep first.

**C. Support Oak Park onboarding (Nic does the data entry tonight/soon).**
Once the real account + units/leases exist: **C7 rolling QA** (each occupied
unit → active lease, correct rent, tenant email, invite sent). Then **C4
live-fire** (small real ACH + card → lands in his Connect → refund from Stripe
Dashboard; note: platform-hold model, no in-app refund route) + **C5 prod
invite→login→pay walkthrough** + **C6 Aug-1 billing dry-check** (invoice cron
already verified code-correct — just confirm no Oak Park lease is left
`needs_review` or behind an unread meter run).

## Open / not-yet-done (Nic asked "anything else")
- **Nic tonight: onboard Oak Park (N2 real landlord account → tell Claude the
  email; N3 units/leases; N4 Connect KYC).** Now UNBLOCKED by Stage 2.
- **Checkr live keys** (Nic self-generates) + flip `landlords.background_provider`
  mock→checkr. Integration is complete; test keys currently.
- **Standalone admin `/reserve` page** still shows the OLD reserve model
  (phases, 3-mo-defaults) — only the Overview was fixed. Update or retire it.
- **`/tenants/enroll-credit-reporting`** is the premature-enroll stub (bypassed
  by survey mode) — clean up when FlexCredit truly launches.
- **FlexCredit launch phase:** Esusu integration + the breakeven gate (needs
  ~1,000 units at 10% adoption, or fewer if the survey shows 30–40%).
- **Nexus/tax:** every `research` rate needs a tax-pro pass before GAM
  registers/collects anywhere (collects $0 today regardless).

## Launch state
Only launch blocker remains the **live Stripe cutover proof** (C4/C5) + Nic's
Oak Park data entry (N2/N3/N4) — the latter now unblocked. All money code
complete + tested; Aug-1 billing verified code-correct.
