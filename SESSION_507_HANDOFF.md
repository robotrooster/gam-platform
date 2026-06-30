# SESSION 507 HANDOFF

## Theme
Launch walkthrough execution — working `WALKTHROUGH_CHANGES.md` (compiled
2026-06-20). Closed the **two real bugs**, the **OTP/On-Time-Pay purge** +
**Stripe white-labeling** wording cluster (landlord), and a batch of
**tab removals/moves** across landlord + PM-company. Everything below is
typecheck-clean (api, landlord, tenant, pm-company all `tsc --noEmit` green).

## Decisions taken (Nic)
- **OTP for launch**: hide ALL landlord-facing OTP surfaces, keep backend
  intact + reversible. (Not ripped out.)
- **Stripe**: purge GAM's own "Stripe Connect"/"Stripe" copy → "bank account"/
  "link bank account"; leave the embedded Stripe-hosted KYC widget as-is
  ("Powered by Stripe" is unavoidable per the locked Connect architecture).
- **ACH fee copy**: removed "No fee" claim — ACH is paid by the tenant by
  default; landlord only if they opt in (per-property `banking_fee_payer`).
- **Pricing**: stale $15 OTP / $5 direct tiers are wrong for launch → flat
  **$2 per occupied unit** ($10/property min, vacant $0). Direct-Pay tier
  collapsed into the flat $2 (see OPEN decision #1).

## Shipped (verified)
### Bugs
- **Bookings SQL crash** (`apps/api/src/routes/bookings.ts:153`): `resolver.name`
  → `COALESCE(NULLIF(TRIM(first_name||' '||last_name),''),email)`. The
  change-request queue 500'd on every load. Verified vs real `users` schema.
- **Tenant notifications white-screen**: root cause was route-ordering in
  `apps/api/src/routes/background.ts` — `GET /:id` (landlord-perm) was declared
  before `GET /notifications`, so Express matched `/notifications` as `:id` and
  403'd tenants; the tenant page then fed the error object into `.filter()` →
  crash. Moved the two notification routes ABOVE `/:id`; hardened
  `TenantNotificationsPage.tsx` (array-coerce + JSON.parse guard). Verified:
  tenant now gets `{success:true,data:[]}`, landlord routes still 403.

### Landlord OTP purge (#1, #2, #8a)
- Dashboard: removed OTP KPI text, OTP Pipeline card, OTP fee tiers; fee modal
  + KPI now flat $2/occupied unit; Next-Disbursement KPI shows next Friday
  payout date (not "SLA 1st").
- Nav + route + import for `/otp` removed (`Layout.tsx`, `main.tsx`).
  `OtpPage.tsx` left orphaned on disk (backend kept).
- Table columns removed: Tenants, Units, PropertyDetail. Badges removed:
  UnitDetail, TenantDetail. Copy de-OTP'd: Register, InviteTenant, AddUnit,
  Properties empty-state. UnitDetail net/yearly math + Platform-fee row → $2.
  PropertyDetail ledger label "OTP withdrawal" → "Scheduled payout".
- KEPT (intentionally): tenant on-time-payment ANALYTICS (rate/streak/%) in
  Screening + TenantDetail — that's behavior data, not the OTP product.

### Stripe wording (#6, #17, #18)
- Disbursements, Banking, Properties: "Stripe Connect" → "bank account"/"link
  bank account". Screening attestation label + Payments "Stripe & ACH" header
  neutralized. Embedded KYC widget untouched.

### Tab removals / moves
- Landlord: **#4** Support tab removed (IM widget stays), **#21** Agent
  Activity tab + dashboard card removed, **#13** FlexCharge tab inside Tenants
  removed, **#27** POS moved to directly under Dashboard, **#33** Record Event
  removed, **#25** Entry Requests folded into Maintenance as a sub-tab
  (Work Orders / Entry Requests; routes kept, standalone nav gone).
- PM-company: **#4** Agent Activity tab + dashboard preview card removed.

### Admin
- **#1** Duplicate Overview/Onboarding fixed via role-gating (Nic's call):
  super-admins see Overview only, regular admins see Onboarding only. Nav +
  `/overview` route guard + index redirect all keyed on role.
- **#2** OTP refs removed: tenant OTP column+cell, enrollment nudge, flex-KPI
  OTP line, tenant On-Time-Pay badge, income KPI → "Platform Unit Fees" ($2),
  Disbursements subtitle. KEPT/FLAGGED (see OPEN): SLA advance alert, Reserve &
  Float copy, super-admin System Features OTP toggle.
- admin-ops has no OTP refs (nothing to mirror).

## Resolved by Nic this session
- **Pricing**: ALL occupied units = $2 (direct-pay included). Already shipped.
- **Admin #1**: role-gate the tabs (super-admin → Overview, regular → Onboarding).
  Shipped.

## Resolved by Nic (cont.)
- **No rent advance at launch.** GAM disburses only settled/collected funds
  (auto-Friday). Admin SLA advance alert → no-advance copy; Reserve & Float
  reframed as loss/operational reserve (chargebacks, ACH returns, float), not
  OTP advance. Super-admin System Features OTP toggle KEPT as the backend
  on/off (reversible). Admin #2 closed.

## No advance / no fee-absorption (Nic directive, S507)
GAM does NOT advance funds and does NOT absorb/eat any fees at launch.
- Admin: removed per-landlord OTP "Beta Features" rent-advance toggle (+ handler/
  state); Reserve & Float removed from launch nav + copy reworded to "not active
  at launch / GAM does not advance or absorb losses" (route+component kept on
  disk — see OPEN #2); disbursement alert already says "GAM does not advance
  rent". All typecheck-clean.
- FlexPay tenant copy already correct ("GAM does not advance funds").
- CONFLICT surfaced (see OPEN): FlexDeposit + landlord onboarding agreement.

## FlexDeposit — REAL model (Nic corrected S507; CLAUDE.md is WRONG on this)
FlexDeposit does NOT advance cash and GAM does NOT eat losses. Actual model:
- Deposit is **"credited" to the landlord's books at move-in** (a bookkeeping
  credit, not a cash advance).
- **GAM collects installments from the tenant and holds the funds in custody.**
- On tenant **default → landlord gets the deposit**; at **move-out (no default)
  → tenant gets it back**.
So FlexDeposit is consistent with "no advancing / GAM eats no fees" — it's the
COPY and risk-comments that are wrong, not the product.

NEXT-SESSION ACTION (FlexDeposit copy rewrite):
- `tenant/src/main.tsx:1069` — rewrite "GAM advances your security deposit to
  your landlord at move-in" → the credit-to-books + GAM-custody + installments
  model above. Keep the "not a loan / not your creditor / no collections" framing.
- `apps/api/src/services/flexDeposit.ts` "GAM eats the loss on default" comments
  (~36/420/570/1441/1464) — correct to reflect custody model (landlord receives
  the held deposit on default; GAM is not absorbing a loss).
- Check `legal/FLEXDEPOSIT_SLA_TEMPLATE.md` + Consumer ToS for the same advance
  language and align.

## S507 continued (post-restart) — all typecheck-clean
- **FlexDeposit copy** (tenant) rewritten to custody model (#7 tenant; backend/legal still flagged below).
- **Settings #34/#35/#36**: flat $2/unit Billing card (no tiers); removed Default Early-Termination Policy card + wiring (fee read from lease only); removed Deposit-Interest-Override card (statutory state rates untouched).
- **#3** verified (rent-volume graph already real). **#28** Inventory copy (business-use, not POS resale). **#26** Documents clarified. **#32** Tenant Record removed from landlord nav (route kept — it's also the dispute-review surface; flagged).
- **Lease PDF generator (Tenant #3 + #26) — NEW, verified end-to-end:**
  - `apps/api/src/services/leasePdf.ts` — renders any lease from terms (pdf-lib, no state-specific language).
  - `GET /api/leases/:id/pdf` (routes/leases.ts) — auth: tenant-on-lease or landlord/team; streams PDF.
  - `/tenants/lease` now returns `document_url` → that endpoint, so the tenant viewer always renders a PDF (was falling back to structured HTML; documentUrl was never populated before).
  - Landlord `LeasesPage` got a **View** action (fetch-with-auth → blob).
  - Demo: alice's lease set executed + end_date 2027-03-31 so the viewer + doomsday clock both show.
  - Verified: endpoint returns valid `%PDF-1.7`, renders cleanly with all terms + signature status.

## S508 (continued, post-lease-PDF) — all typecheck-clean
- **#19** Payments show payer name (list column + detail "Attempted by"/"Paid by").
- **#9** Photos only flagged when the unit's "Listed" toggle is on (no nag on imported/occupied units).
- **#28** Inventory subtitle = business-use supplies, not POS resale.
- **#2 (tenant)** Application tab hidden for existing tenants (gate = bgApproved OR has active-lease unitId; was gating the whole portal on bgApproved).
- **#5 (PM)** Fee-type dropdown → Title Case.
- **#31** partial: no raw Checkr data shown (done); emailable prospect link = BUILD remaining.
- **#30** NOT done — needs cohesive build (remove search + proximity sort needs backend distance ordering vs landlord property coords). Don't half-do (removing search alone regresses UX).
- **Business #2 error boundaries (DONE)**: recon found 11/12 portals already had a root SentryErrorBoundary; only **business** lacked one (cause of its dashboard black-screen). Added reusable `ErrorBoundary` to every portal's `src/components/ErrorBoundary.tsx`; wrapped business root + each business dashboard tile. Other dashboards: root protection already present; component now available for per-tile adoption. NOTE: ErrorBoundary.tsx exists in all 12 apps but is only wired in business so far (intentional infra for incremental tile wrapping).

## Admin cluster (DONE this session)
- #3 CSV tab kept (per instruction). #4 "Credit Disputes" → "Reporting Disputes"
  (nav + page + clarifying subtitle; not removed — system is real/FCRA). #5 admin
  Subleases = platform-wide read-only oversight (recommend keep). #6 empty
  "Community/Tools" section labels now hidden for regular admins (they only held
  super-admin items). CONFIRM: remove Security/2FA-disable? left as-is.

## Latest batch (DONE): Tenant #4 (Flex Advantage nav already exists), Landlord
#37 (FlexCharge interest copy clarified), POS #3 (tax-tab "Landlord-wide" →
"All locations"). POS #2 (charge-account names) + Business #10 (POS tab → portal,
auth wrinkle) left as builds/confirms.

## Quick confirms waiting on Nic (no code blocked)
- Admin #6: remove the Security/2FA-disable capability? (left as-is)
- Admin #5: keep admin Subleases oversight? (recommend keep)
- POS #3: also rename "Landlord-wide" on the items + categories tabs? (only tax tab done)
- Business #10: SSO business owner into the POS portal, or keep in-business POS page?

## Progress: 49 done / 4 partial / 50 open. Remaining splits into:

### Quick wins still available (copy / removal / simple wiring)
- Tenant #4 (Flex Advantage opt-in nav — may already exist as "⭐ Flex Advantage"), #5 profile-score KPI card.
- Landlord #16 (subleases read-only — mirror #15), #37 (FlexCharge interest copy).
- POS #2/#3 (charge-accounts names + tax dropdown "All locations"), Business #10 (POS tab → open POS portal).
- Admin #3/#4/#5/#6 (CSV keep, Credit Disputes clarify/remove, Subleases investigate, dead tabs Community/Tools/Account + Security/2FA).
- Operations #1/#2/#3 (clickable Flex/vacant/occupied cards, per-product invite).
- PM #3 (self-register model C: verify email prod / auto dev).
- Marketing #2/#3/#4 (copy — but #1 "revisit after rest locks" per Nic, so do Marketing LAST).
- Admin&Ops #1 (two staff tiers — mostly already real; verify/label).

### Genuine builds (each a focused mini-project)
- Landlord #7 onboarding in-browser form + agreement rewrite (drop OTP SLA/advance, $2/unit) — overlaps FlexDeposit/no-advance.
- #10 Master Schedule overhaul, #11 bookings waitlist, #12 payment-health card→tenant, #15 view-only lease modal + move-in pics, #20 Reports clickable P&L, #23/#24 inspections (agent remote-ask once / manual auto-form), #29 work-trade↔lease labor billing, #30 applicant-pool proximity, #31 prospect-invite, #8b eviction-mode allows GAM-balance payments.
- Business #2 error boundary (all portals), #3 camelize digit-key audit, #4 billing intervals, #5 recurring qty/price, #6 generalize quotes, #7 calendar+sync, #8 hosted self-booking site, #9 deposits, #11 customer self-enter, #12 route arrival stamps, #13 inline route map, #14 live route insert, #15 self-host Nominatim, #16 sequential stop completion.
- Fitness #1 AI plan agent, #2 leaderboards, #3 nutrition, #4 routines↔agent, #5 Top-8 follow, #6 in-session timer.
- Property Intel #1 data accuracy (later), Listings #1 application→Checkr→pool.
- Backend: FlexDeposit logic rework to custody model; admin $2/unit income migration.
- #5 (verify agent "David") — needs chat model up + manual agent testing.

## OPEN — need Nic
1. **Landlord OnboardingPage participation agreement** (`OnboardingPage.tsx`
   ~126/167/169/380/381/410): built entirely on the OTP SLA rent-advance +
   "regardless of when tenant pays" guarantee + stale $15/$5 fees. All now
   invalid. Fold the rewrite (drop advance/SLA, $2/unit) into #7 (in-browser
   onboarding rework).
2. **Backend platform-fee income**: admin income panel still sums
   `otpUnitFees`/`directUnitFees` at legacy $15/$5. Needs a $2/unit migration in
   the income calc for accurate admin totals (frontend labels already say $2).

## Resolved (Reserve & Float)
Keep DORMANT — removed from launch nav; route + component left on disk
(super-admin direct-URL only). Not deleted. Copy reworded to "not active at
launch; GAM does not advance or absorb losses."

## Next targets (unblocked, in order)
- **Stripe-sweep follow-up**: `landlord/src/pages/TeamPage.tsx` (~8 manager
  direct-deposit "Stripe Connect" refs); PM-company Dashboard getting-started
  "Stripe Connect" line.
- **#7 Onboarding rework**: `OnboardingPage.tsx` still has the Landlord
  Participation Agreement block (OTP SLA legal copy + stale $15/$5 fees) — fold
  the rewrite into the in-browser-form work.
- Then the rest of WALKTHROUGH_CHANGES.md (Tenant, Marketing, POS, Property
  Intel, Listings, Operations, Business, Fitness, Platform).

## Notes
- Stack was booted via `~/gam-start.sh` (all 13 portals + api + models).
- Verification: per CLAUDE.md, visual smoke checks batch into Nic's list — used
  `tsc` as the gate for UI edits; the two real bugs were verified at the API.
- `WALKTHROUGH_CHANGES.md` checkboxes updated: `[x]` done, `[~]` partial,
  `[ ]` open. Big uncommitted tree continues (last commit S496 per S506).
