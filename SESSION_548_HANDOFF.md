# SESSION 548 HANDOFF

## Theme
The long-stay lifecycle CLOSED end to end: calendar-aligned billing engine
(the deferred half of S547's spec), same-day end-of-stay settlement (final
meter read → immediate invoice → deposit sweep → refund), pull-out meter
prompts, staff deposit-return approval thresholds, and the unit-type
move-out inspection gate with during-move-out scheduling. All verified by
tests (300+ green across runs) + live browser preview of the approval flow.

## 1. Long-stay billing engine (services/bookingLeaseBilling.ts — NEW)
- Booking-sourced leases (lease_source='booking_draft', end_date set) bill
  the SAME computeMonthlyStaySchedule as the quote: move-in invoice =
  prorated arrival (monthly/30 — moveInBundle branches; regular leases keep
  days-in-month), cron invoices flat monthly on the 1st, final partial
  month prorated (invoiceGeneration: bookingRentForDueDate segment lookup;
  no segment → no rent that cycle). rent_due_day default 1 does the rest.
- **Master Schedule = source of truth for money** (syncLeaseWithBookingDates,
  called from the booking PATCH): pending drafts follow date changes;
  active leases get end_date moved, no-longer-owed PENDING rent deleted
  (empty invoices removed), and rent settled beyond the new obligation
  banked as lease_prepaid_credits — which invoiceGeneration ALREADY nets
  against the next invoice (existing FIFO rail). Start-date changes on an
  ACTIVE lease are NOT auto-applied (notification: amend the document).
- Leftover credit at lease end joins the deposit-return tenant pool
  (calculate + finalize zero the rows FOR UPDATE in-tx). Tested.

## 2. End-of-stay same-day settlement (Nic: "neither party waits a month")
- Final rent invoice = prorated days on the 1st, normal payability/late
  fees (no meter hostage → no exemption needed).
- **Attribution fix** (tryInsertBill, utilityBilling): a cycle's usage
  belongs to the lease covering the START of the cycle month — never the
  newly-active same-day arrival, and works after lease expiry (fallback:
  newest overlapping lease). READ THE METER AT TURNOVER (late reads fold
  gap days onto the departing tenant).
- **Immediate invoicing** (generateFinalUtilityInvoice in invoiceGeneration;
  invoiceEndedLeaseBills hook in utilityBilling): a bill landing on an
  ENDED lease is invoiced same-day (dated/due today), both parties
  notified; unpaid at deposit finalize → S180 sweep settles it. Deposit
  return also materializes bills (ensureBillsForUnit) + sweeps uninvoiced
  final utilities as their own deduction bucket, marking bills paid with
  paid_via_deposit payments rows (meter reads in the note).
- **Pull-out meter prompt** (promptMoveOutMeterReads, utilityReadingRuns;
  7am cron): every departure TODAY on a submetered site → landlord +
  reading-permission staff notified (per-property, idempotent/day). Fires
  for short stays too — the read baselines the meter for the next guest.
- Fixed en route: monthly-tier reprice on booking PATCH + staff create now
  uses the calendar schedule (was flat nights/30).
- Refunds = negative landlord-owes-tenant payments (existing) → net from
  the landlord's balance at disbursement. Nic confirmed this design.

## 3. Deposit-return approval threshold (migrations 20260719110000/110100)
- landlords.deposit_return_approval_threshold (default $500, Settings UI
  under the maintenance threshold; 0 = approve everything).
- deposit_returns gains status 'awaiting_approval'. Staff finalize with a
  LIVE-computed refund above the threshold → parks + landlord notified
  (auto); at/below (or gap/zero) → finalizes solo. Owner-level roles
  bypass and release parked returns ("Approve & Finalize").
- Page states: staff sees "Send to Landlord for Approval" pre-click,
  amber "Awaiting landlord approval" banner + DISABLED "Landlord
  reviewing…" button after. Live-previewed with Dana.
- Demo: Dana (testdesk-demo@golddoor.io / testdesk-demo — password reset
  this session) now has leases.deposit_return; a parked $1000 return sits
  on Henry's RV 01 lease at Sunset Palms for walkthrough.

## 4. Move-out inspection gate (Nic's unit-type matrix)
- shared: MOVE_OUT_INSPECTION_REQUIRED_UNIT_TYPES = apartment,
  single_family, mobile_home, storage, parking (rv_spot EXEMPT — its
  walkthrough is the meter read). buildInspectionChecklist: storage/
  parking get a tiny 2-area template (Contents; Door & lock vs move-in).
- POST /:id/deposit-return 409s without a FINALIZED move_out inspection
  on gated types. GET exposes move_out_inspection_required + inspection
  {id,status,scheduled_for,photo_count}; DepositReturnPage: gate card +
  disabled "Walkthrough required first" Begin + "View walkthrough (N
  photos)" link on the approval view.
- **Scheduling (services/moveOutInspections.ts — NEW, 7am cron)**: window
  opens 3 BUSINESS DAYS BEFORE lease end (inspect WHILE they move out),
  deadline = end_date. comparison_inspection_id ← move-in inspection.
  Landlord + property-assigned staff notified; 2-day catchup arrives
  flagged OVERDUE. addBusinessDays/subtractBusinessDays use
  US_FEDERAL_HOLIDAYS (jobs/autoPayouts — refresh annually).
- In-person by design: these are staff-conducted; tenant-guided agent
  flow stays in the periodic lane.

## Decisions (Nic)
- Monthly-stay guests see rate + deposit only; billing = calendar cycle.
- Final utility settles from the deposit; refunds from landlord balance.
- Meter read ON the pull-out date is the operational rule (in runbook).
- Approval threshold defaults $500; gate keys off LIVE refund math.
- Move-out gate is per unit type globally (no per-property toggle until
  someone asks). Walkthrough during move-out, not after.

## NEXT PHASES (this handoff's reason)
1. **Periodic inspection verdict loop**: tenant self-directed (agent)
   photos → front desk PASSES (finalize, exists) or flags SUSPICIOUS →
   auto-schedule an in-person physical inspection + notifications. Capture
   side exists (agents/tools inspection checklist); build = verdict action
   + scheduling + surfaces.
2. **Carpet-cleaning clause (conditional lease fees)** — the big one:
   - Parser (jobs/leaseParser/): new extractor for "professional carpet
     cleaning required within N days of move-out, else $X" → lease_fees
     row. Parser has anchors/extractors/auditTrail structure; lib/pdfText
     is OFF-LIMITS (Nic).
   - Schema: lease_fees conditional concept (e.g. inspection_condition
     text) — conditional fees must NOT auto-sum into the S180 move-out
     sweep (calculateDepositReturn sums due_timing move_out/other
     unconditionally today).
   - Move-out inspections on carpeted types get a "Carpets professionally
     cleaned (receipt)?" yes/no item; NO → charge the LEASE's fee.
   - HARD RULE: no clause in the lease → no fee, damage lines only
     (document-first / lease-is-law).
3. **Storage abandonment/auction workflow** (own session): abandoned flag
   → landlord-configurable notice sequence (NO state-specific law — GAM
   scaffolds, landlord owns compliance) → cure cutoff → auction
   disposition (sale amount vs balance, surplus). Deposit consumed via
   existing gap machinery.
4. Carryovers: storefront prod wiring (wildcard *.gam.biz DNS,
   STOREFRONT_URL_TEMPLATE, captcha, landlord inquiry inbox), FlexPay OCR
   for photo proofs, Nic-gated Stripe/Checkr/DoorLoop.

## Files touched (S548)
api NEW: services/bookingLeaseBilling.ts, services/moveOutInspections.ts,
jobs/bookingLeaseBilling.test.ts. api EDIT: jobs/invoiceGeneration.ts
(lease_source, segment rent, generateFinalUtilityInvoice), jobs/
moveInBundle.ts (booking arrival proration), services/utilityBilling.ts
(attribution, invoiceEndedLeaseBills), services/utilityReadingRuns.ts
(promptMoveOutMeterReads), services/depositReturn.ts (prepaid credit pool,
final-utility sweep, awaiting_approval), routes/units.ts (sync hook,
monthly reprice), routes/leases.ts (finalize threshold gate, GET approval+
walkthrough meta, begin gate), routes/landlords.ts (threshold PATCH),
jobs/scheduler.ts (7am: meter prompt + inspection scheduling), tests
(leases-gap-close +5, depositReturn +3). landlord: DepositReturnPage
(threshold + walkthrough states), SettingsPage (deposit threshold field).
shared: computeMonthlyStaySchedule consumers, STORAGE_INSPECTION_AREAS,
MOVE_OUT_INSPECTION_REQUIRED_UNIT_TYPES. Migrations: 20260719110000
(threshold), 20260719110100 (awaiting_approval status).

## Watchouts
- Suites for this work: jobs/bookingLeaseBilling.test.ts (15),
  leases-gap-close (26), depositReturn (17), utilityReadingRuns,
  s537-payment-fifo, workTradeCredit, leaseLifecycle, inspections — all
  green at close.
- leases-gap-close MOCKS services/depositReturn — threshold tests drive
  calculateDepositReturnMock; don't assert real math there.
- US_FEDERAL_HOLIDAYS (jobs/autoPayouts.ts) seeded 2026–2027 only —
  annual refresh, now used by move-out scheduling too.
- The begin-move-out gate applies to seedUnit's default 'apartment' —
  suites hitting POST /:id/deposit-return must seed a finalized move_out
  inspection (see gap-close happy test) or use rv_spot.
- Demo rows left ON PURPOSE: Dana's parked $1000 deposit return (Henry
  RV 01), Dana's password/permission, Sunset Palms storefront content.
- generateFinalUtilityInvoice collides (lease_id, due_date) with same-day
  cycle invoices → returns null; deposit sweep is the backstop.
