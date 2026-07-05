# SESSION 531 HANDOFF

## ⚠️ NIC'S CLOSING FLAG — READ FIRST
Nic at shutdown: **"several of my walkthrough changes got skipped or were
not handled correctly — we will address that later."** Next session: expect
Nic to bring a correction punch list from re-walking the portal. Do NOT
assume the ✅ entries in FINAL_WALKTHROUGH.md are all truly right — when he
calls one out, re-open it, fix it against what he actually asked for, and
mark the entry corrected. Treat his list as the source of truth over the
tracker's claims.

## Theme
FINAL WALKTHROUGH mega-session: Batches 6, 7, and 8 all closed — every
Claude-buildable item on the landlord list shipped (W-46, W-14, W-15, W-2,
W-32, W-12, W-7, W-25, W-26, W-27, W-34, W-36, W-44, W-53, W-54, W-20 incl.
best-fit + extension protection, W-56a/b). Remaining: Checkr (W-49/50,
blocked on account), W-56 walk continues, W-42 agents last — PLUS Nic's
correction pass above. Uncommitted (Nic commits).

## NIC DECISIONS + STANDARDS CAPTURED (recorded inline per tracker item)
- **"THE LEASE IS THE DOCUMENT"** (standing standard, in memory +
  gam-lease-is-law.md): no GAM form collects lease terms — rent/dates are
  typed INTO the drafted e-sign document only. W-7 rebuilt to comply.
- **W-32**: instant withdrawal 2% min $5 **UNCAPPED** (Stripe's 1.5% is
  uncapped → "we don't cap either").
- **W-20**: FULLY AUTOMATIC compression; sites assigned internally, guest
  learns theirs 1 HOUR BEFORE check-in time; objective = CONSOLIDATE
  (best-fit into snug gaps, wide-open sites stay free for long stays);
  EXTENSIONS: boot the incoming unrevealed reservation → else move the
  EXTENDING guest to any site fitting the whole stay → else 409.
- **W-44**: holds split (closures → Maintenance tab); tenant private
  events: non-refundable deposit → paid → property-wide announcement;
  unpaid at start → auto-release; per-area landlord settings.
- **W-27**: keep pending pool + unit-hold protection (built).
- **W-36**: sub-meters = build now ("RV spots are always sub-metered").
- **W-56a**: work-trade hours target is PER PERSON (agreement), property
  value = default for new agreements only. **W-56b**: roster row → lease.
- **W-50 research**: Checkr pass-through OK, platform carries FCRA; state
  application-fee caps (CA actual-cost ~$65.86 / NY $20 / PTSR waivers)
  constrain margin — Nic decides nationwide-lowest vs per-state catalog at
  build.

## SHIPPED (one line each; full detail inline in FINAL_WALKTHROUGH.md)
- W-46 inventory rebuild (parts CRUD + service schedules + 9am alerts)
- W-14 CSV template killed; white-glove path (sales@goldassetmanagement.com)
- W-15 direct_pay retired platform-wide (migration 150000; occupied
  unified to active+delinquent+suspended everywhere)
- W-2 /rent-roll page + KPI click-through (same formula, can't drift)
- W-32 instant-fee engine (2%/min$5, margin account-debit + reversal,
  7 tests, user-favor rounding invariant; strip always visible)
- W-12 POS per-property (page-level picker both frontends; POST requires
  propertyId; EOD per (landlord, property, day); migrations 160000-200)
- W-7 renewal decision workflow (renews_lease_id 170000; zero-input form;
  deposit carry-forward; activatePendingLeases; lease-end handoff;
  Apt 202 draft LIVE on /esign for the walk)
- W-25 payment timeliness drill-in · W-26 credit off landlord view
- W-27 pending-tenant unit hold (180000; availability + booking guards)
- W-34 verified works-today (no mock on landlord banking)
- W-36 utilities UI (meters/readings/assignment/bills/finalize + tenant
  nav; FIXED isoMonthStart tz bug that billed the wrong month)
- W-53 prefs merged into Settings · W-54 work trade unhidden (+W-56)
- W-20 full compression system (site-type public booking, best-fit packer
  + booking-time ranking, 1hr-before reveal ~ THE movement fence,
  3-tier extension protection; migration 190000; TWO double-booking bugs
  caught by tests: ranker single-candidate shortcut + pg-Date-vs-string
  NaN coercion — both fixed and pinned)
- W-44 hold split + private events (200000; deferred announce until
  deposit settles; auto-release; commonAreas 16/16)
- W-56a per-person work-trade targets (210000) · W-56b row → lease

## DEMO STATE FOR NIC'S WALKTHROUGH
- Apt 202 renewal draft on /esign (fill terms IN the document, sign, send)
- Pedestal Row A sub-meter + $35 July bill 'billed' to Grace (RV 08)
- Grace's work-trade agreement (15.5h approved + 2 pending; target 60 after
  the live edit test)
- sunset-palms public booking site (site types, no unit numbers)
- All of the above mirrored into seedDemo.ts (reseed-safe; template seed
  guarded against duplication)

## TESTS / STATE
- Suites green at close: pos 83, leases 59+22, units 20+31, bookings 8,
  maintenance-portal 26, withdrawals 7 (new), scheduleCompression 11 (new),
  publicPropertyBooking 12 (rewritten), commonAreas 16, workTrade 26,
  scheduler smoke. tsc clean: api, landlord, tenant, pos, customer, shared.
- Migrations applied this session (8): 150000 direct_pay retire,
  160000/160100/160200 POS property + EOD, 170000 renews_lease_id,
  180000 pending-intent unit, 190000 site reveal, 200000 private events,
  210000 work-trade per-agreement target. schema.sql regenerated.
- Artifacts cleaned throughout; deliberate demo state kept (list above).
- `npx jest` is broken (npx cache) — use `npm test -- <file>` in apps/api.

## NEXT SESSION (in order)
1. **NIC'S CORRECTION LIST** — the skipped/mishandled walkthrough items he
   flags. Re-open each tracker entry he names; the fix goes against HIS
   words, not the tracker's summary of them.
2. **W-56 continue** — Nic resumes the work-trade walk; take items live.
3. **W-49/W-50 Checkr** — after Nic opens the account; pricing-cap
   decision recorded in tracker.
4. **W-42 agents** LAST — scope the upgrade list with Nic, then re-ingest
   against the post-fix demo world + tool audit.
5. Then: other portals' walkthrough passes (tenant, admin, admin-ops,
   marketing, POS) + launch infra (Vercel Pro, Resend, Stripe webhook,
   host migration off the Mac).

## SERVICES
Launch set only; landlord under Claude preview :3001; API :4000
ts-node-dev (hot-reloaded all session — no restarts needed).
