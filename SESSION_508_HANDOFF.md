# SESSION 508 HANDOFF

## Theme
Executing the launch walkthrough in **`WALKTHROUGH_CHANGES.md`** (compiled
2026-06-20). That file is the LIVE per-item tracker — `[x]` done, `[~]` partial,
`[ ]` open, each with an inline note. Read it for item-level detail; this handoff
is orientation + decisions + what's left.

**Current count: 49 done / 4 partial / 50 open.** Everything shipped is
typecheck-clean (api, landlord, tenant, admin, admin-ops, pos, pm-company,
business all `tsc --noEmit` green). Work is uncommitted (last commit S496; Nic
decides when to commit).

## LAUNCH RULES (Nic-confirmed — these override stale CLAUDE.md notes)
Also saved to memory `gam-launch-no-advance-no-fee-absorption`.
- **GAM does NOT advance funds at launch.** No rent advance / On-Time Pay (OTP),
  no disbursement guarantee. Payouts = collected/settled balances only, auto-Friday.
  OTP backend kept but ALL landlord UI surfaces removed (reversible).
- **GAM absorbs/eats NO fees.** No "GAM eats chargebacks/ACH returns/losses" copy.
  ACH fee is tenant-paid by default; landlord only if opted in (`banking_fee_payer`).
- **Flat pricing, no tiers:** $2/occupied unit (active OR direct-pay), vacant $0,
  $10/property min. Old $15-OTP/$5-direct tiers are wrong everywhere.
- **FlexDeposit is NOT a cash advance:** deposit credited to landlord's books at
  move-in; GAM collects installments + holds custody; landlord gets it on default,
  tenant at move-out. (CLAUDE.md still describes the old "advance" model — stale.)
- **Stripe white-labeled:** GAM's own copy says "bank account"; the embedded
  Stripe KYC widget stays ("Powered by Stripe" unavoidable).

## New reusable infrastructure built this session
- **Lease PDF generator:** `apps/api/src/services/leasePdf.ts` + `GET /api/leases/:id/pdf`
  (auth: tenant-on-lease or landlord/team). Renders ANY lease from terms (no
  state-specific language). Tenant `/tenants/lease` returns `document_url` → this
  endpoint; landlord LeasesPage has a "View" action. Verified (valid %PDF).
- **ErrorBoundary:** `apps/<each>/src/components/ErrorBoundary.tsx` in all 12
  frontend apps. Wired at business root + business dashboard tiles. Other portals
  already had a root SentryErrorBoundary; the component is available for per-tile
  adoption everywhere.

## Shipped this session (high level — see WALKTHROUGH_CHANGES.md for each)
- **Bugs:** bookings `resolver.name` SQL crash (#38); tenant notifications
  white-screen (route-order shadow on /background/:id) — both verified at API.
- **OTP purge** (Landlord #1/#2/#8a, Admin #2): all OTP surfaces removed, backend
  kept; Next-Disbursement KPI shows real next-Friday; fee model → $2/unit.
- **Stripe white-label** (#6/#17/#18 + TeamPage + Screening/Payments labels).
- **No-advance / no-fee-eating copy** purged from admin (Reserve & Float off nav,
  SLA advance alert replaced, OTP toggle removed); FlexDeposit tenant copy fixed.
- **Settings:** #34 flat $2 Billing card (no tiers), #35 removed default
  early-termination card, #36 removed deposit-interest-override card.
- **Tabs:** Support (#4), Agent Activity + dashboard card (#21), FlexCharge-in-
  Tenants (#13), Record Event (#33), POS moved up (#27), Entry Requests → folded
  into Maintenance sub-tab (#25); PM-company Agent Activity (#4); Tenant
  Application tab hidden for existing tenants (Tenant #2).
- **Admin #1** duplicate Overview/Onboarding → role-gated; **Admin #3–6** cluster
  (CSV keep, Credit Disputes → "Reporting Disputes", Subleases = oversight keep,
  dead section-labels hidden).
- **Lease viewer (Tenant #3 + #26)**, **Payments payer name (#19)**, **photos
  only-when-listing (#9)**, **Inventory copy (#28)**, **PM fee-type Title Case
  (#5)**, **FlexCharge interest copy (#37)**, **POS tax-tab "All locations" (#3)**,
  **Tenant Flex Advantage nav verified (#4)**, **error boundaries (Business #2)**,
  **#3 rent-volume graph verified real**.

## Partials [~]
- #17 (mostly done), #31 (no-Checkr-data done; prospect-invite = build),
  #32 (Tenant Record off nav; route kept — also dispute-review surface),
  Admin #6 (dead labels done; 2FA-disable removal = confirm).

## Quick confirms waiting on Nic (nothing blocked)
1. Admin #6 — remove the Security/2FA-**disable** capability? (left as-is)
2. Admin #5 — keep admin Subleases oversight? (recommend keep)
3. POS #3 — also rename "Landlord-wide" on the items + categories tabs? (only tax tab done)
4. Business #10 — SSO business owner into POS portal, or keep the in-business POS page? (POS app needs landlord auth today)

## REMAINING BUILDS (~the 50 open) — each a focused mini-project
- **Landlord:** #7 onboarding in-browser form + agreement rewrite (drop OTP-SLA/
  advance, $2/unit), #8b eviction-mode allows GAM-balance payments, #10 Master
  Schedule overhaul, #11 bookings waitlist, #12 payment-health card→tenant, #15
  view-only lease modal + move-in pics, #16 subleases read-only (mirror #15), #20
  Reports clickable P&L, #23 inspections remote-ask-once, #24 manual inspection
  auto-form, #29 work-trade↔lease labor billing, #30 applicant-pool proximity
  (remove search + backend distance sort), #31 prospect bg-check invite (needs
  public submission flow), #5 verify agent "David" (needs chat model + manual test).
- **Business (15):** #2 error-boundary already done; #3 camelize digit-key audit,
  #4 billing intervals, #5 recurring qty/price, #6 generalize quotes, #7 calendar
  + Apple/Google sync, #8 hosted self-booking site, #9 deposits, #10 POS link,
  #11 customer self-enter info, #12 route arrival stamps, #13 inline route map,
  #14 live route insert, #15 self-host Nominatim (`GEOCODER_URL`), #16 sequential
  stop completion.
- **Fitness (6):** #1 AI plan agent, #2 leaderboards, #3 nutrition tracking, #4
  routines↔agent, #5 Top-8 follow, #6 in-session rest/HIIT timer.
- **Tenant:** #5 profile-score KPI card, #6 require move-in inspection before access.
- **Operations:** #1 No-Flex clickable list, #2 vacant/occupied clickable cards,
  #3 per-product Flex invite. **POS:** #2 charge-account names.
- **PM:** #3 self-register model C (verify email prod/auto dev).
- **Property Intel #1** data accuracy (later). **Listings #1** application→Checkr→pool.
- **Marketing (#1–4):** Nic said do LAST, after the rest locks.
- **Backend:** FlexDeposit logic rework to custody model (flexDeposit.ts +
  legal/FLEXDEPOSIT_SLA_TEMPLATE.md + Consumer ToS §9 still on advance model);
  admin platform-fee income calc still sums $15/$5 — needs $2/unit migration.

## Recommended next-session order
1. **Business route ops #12–16** (cohesive; Acme Hauling demo seeded for it).
2. Landlord Reports P&L (#20) / view-only lease (#15) / Master Schedule (#10).
3. FlexDeposit backend + legal alignment (sensitive — its own session).
4. Fitness cluster. 5. Marketing LAST.

## How to start next session
- `~/gam-start.sh` boots all 13 portals + api + models. Demo logins + ports are
  in WALKTHROUGH_CHANGES.md "Session context".
- Per CLAUDE.md: visual smoke checks batch into Nic's list — use `tsc` as the gate
  for UI edits; verify real bugs at the API/DB layer.
- Pick ONE cluster, recon real code first, drive to done + typecheck, update the
  WALKTHROUGH_CHANGES.md checkbox with a note.
