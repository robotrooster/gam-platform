# SESSION 533 HANDOFF

## Theme
Nic's live evaluation of the meter/utilities world — nine corrections and
three new subsystems in one sitting, each iterated to his spec in real
time: per-meter digits + auto-rollover, suspicious-usage thresholds, the
VERIFICATION WALK redesign (double-check = second physical read, not a
landlord modal), meters moved onto the UNIT, sewer folded into the water
meter, per-property utility TAX, the PROPANE tank-fill subsystem with
payment priority, and tenant-invoice read transparency. Uncommitted (Nic
commits). 12 migrations applied (list below).

## THE WORKFLOW AS IT NOW STANDS (supersedes S532's description)
1. Run opens automatically per property on the LAST BUSINESS DAY of the
   month (weekend/federal-holiday walk-back; daily 7am Phoenix tick),
   prompting landlord + property staff.
2. MAIN WALK: blind + linear, one step per UNIT with a typed input per
   applicable utility. Input is digits-only, exactly the meter's own
   width (per-meter `digits` 4–8, landlord-set, shared
   METER_READING_DIGIT_OPTIONS). No priors, no giveaways, Next-only.
3. ROLLOVER IS AUTOMATIC: below-previous wraps at 10^digits; a plausible
   wrap (< half the meter's range) marks is_rollover and bills with no
   friction. Wrap ≥ half range = probable typo/meter-swap → silent flag.
   SUSPICIOUS USAGE also silently flags: wrap-aware usage over the
   utility's threshold (shared METER_USAGE_ALERT_THRESHOLDS — electric
   5,000 kWh, water 10,000 gal, Nic's first guesses, tune freely).
   Submeters only; RUBS untouched (Nic: completely separate system).
4. VERIFICATION WALK (Nic's redesign — flags NEVER interrupt): when the
   main walk finishes, the system builds a blind re-read list — every
   suspect + RANDOM clean meters to ≥6/month (utility_reading_double_
   checks + 'double_check' run status). Reader can't tell which are
   suspects. Re-read within 1-2 units (METER_DOUBLE_CHECK_TOLERANCE) →
   FIRST read stands, drift bills next cycle; bigger diff → re-read
   replaces. A re-read-CONFIRMED below-previous value is the only
   landlord escalation (rollover vs meter swap = money decision;
   resolve-review modal, re-bills on resolution).
5. BILLING fires at verification completion via the S90 engine → bills
   auto-finalize → S178 invoice cron folds them into the next monthly
   invoice. The invoice LINE ITEM shows "Electric meter 001000 → 001250
   · 250 kWh" (reading_start/reading_end snapshots on utility_bills —
   blind rule protects the READER only; the TENANT gets transparency).

## NIC DECISIONS THIS SESSION (chronological)
- Meter reads = odometer values, leading zeros, typed-only input. Then:
  digit WIDTH is per-meter (water often 4, some 7-8), default 6.
- Rollover: NO double-check friction ("RV parks roll meters constantly").
  Half-range guard is my engineering call he accepted implicitly — real
  rollovers never trip it.
- Suspicious usage: flag over ~5k kWh ("never seen over 1500"), water
  ~10k gal (unsure — tunable).
- Double-check = SECOND PHYSICAL READ padded with random meters, min
  5-6/month; 1-2 unit drift → ignore second read ("captured next cycle").
- METERS LIST SHOULD NOT EXIST ANYWHERE — meters are configured in the
  unit add area (AddUnitModal utilities section incl. batch adds; edit
  via UnitDetailPage Sub-meters card). /utilities = workflow page only
  (run banner, double-check queue, bills, propane, tax).
- SEWER IS NOT A METER: it bills off the water reading at a second rate,
  ONE line item (usage × (water rate + sewer rate)); tax computed
  per-portion at each type's rate under the hood. Deduct-meter case = a
  second water meter with no sewer rate. Flat sewer = lease fee.
- GAS: RV gas is PROPANE TANK FILLS; natural gas single-family is
  direct-billed by the utility. No metered-gas billback until a real
  use case ('gas' hidden from meter UI; schema enum intact).
- PROPANE: gallons × PER-FILL PPG (fluctuates; deliberately NOT linked
  to POS pricing; big tanks can get better rates). Splits ONLY 2 or 4:
  <25 gal never, 4-way needs 100+ gal (propaneSplitOptions — my
  25/100 boundary interpretation of "tanks that are 100-150 can be 2
  or 4"; CONFIRM the 25-99 → 2-only reading with Nic). Property opt-in
  toggle. Payment 1 due IMMEDIATELY (standalone payments row,
  entry_description='PROPANE'); rest ride consecutive monthly invoices.
- Late fees: propane installments on an invoice follow the invoice's
  NORMAL late-fee rules (his earlier "exempt" superseded same-session;
  the standalone first payment is simply outside the invoice mechanism).
- REFILL GATE KILLED same-session: the propane truck doesn't coordinate
  — a new fill ACCELERATES the prior balance (every remaining
  installment becomes a due-now standalone payment; installments.
  accelerated=TRUE marks them).
- PAYMENT PRIORITY: GAM balance → accelerated propane → rent. NEVER
  interrupt ACH: the rent charge pulls in full; settle-time
  redistribution (services/propaneRedistribution.ts, in the webhook tx
  after supersedence) satisfies accelerated propane rows whole-row
  oldest-first, splits the rent row into settled portion + pending
  is_remainder row, notifies tenant ("$270 was applied to your propane
  balance first"). Pay route returns an upfront propaneNotice.
- MONEY FLOW REAFFIRMED: tenant ACH → platform rails (Connect BALANCE);
  landlord is paid ONLY by the Friday batch payout. Redistribution is
  ledger-only; comments corrected to say so.
- UTILITY TAX: per utility type per property, landlord-entered
  (property_utility_tax_rates; 'propane' rides the table), snapshotted
  at billing, SEPARATE amount alongside each charge.
- Tenant invoice shows begin/end reads + usage (line-item notes +
  utility_bills.reading_start/reading_end).
- TENANT /utilities PAGE DELETED ("no extra clutter") — invoice line
  detail is the tenant surface. Nav + route + page removed; GET
  /utility/bills tenant branch left intact (harmless API).

## MIGRATIONS APPLIED (12, in order)
110000 meter digits · 130000 double-checks + run status · 140000 (prior
session context: needs_review) actually S532 — this session starts at
110000 · 150000 propane fills/installments + property toggles · 153000
entry_description +PROPANE · 160000 tax rates + bill/fill tax columns ·
170000 drop refill block · 180000 installments.accelerated · 190000
payments.is_remainder + lease rent index carve-out · 193000 unit rent
index carve-out · 210000 sewer_rate_per_unit + bills.utility_type +
widened UNIQUE (meter,unit,cycle,type) · 213000 bills sewer-rate
snapshot · 220000 bills reading_start/reading_end.
NOTE: applied migration 150000's header says propane is "EXEMPT from
late fees" — superseded same-session (normal invoice rules); can't edit
applied files. Trust this handoff + code comments.

## FILES (main)
- api: services/utilityReadingRuns.ts (double-check phase),
  services/utilityBilling.ts (rollover, thresholds skip, sewer-combined
  line, tax, read snapshots), services/propaneRedistribution.ts (NEW),
  routes/utility.ts (runs, double-checks, flagged/resolve, tax-rates,
  meter digits/sewer), routes/propane.ts (NEW) + mounted in index.ts,
  routes/payments.ts (propaneNotice), routes/webhooks.ts
  (redistribution + tenant notification), jobs/invoiceGeneration.ts
  (propane installments + tax-inclusive utility children + read notes),
  jobs/lateFees.ts (exemption reverted — untouched behavior),
  test/dbHelpers.ts (new tables cleanup + utilityType on seedUtilityBill).
- landlord: UtilityMetersPage.tsx (workflow-only page: banner/verify
  walk/double-check queue/bills w/ tax col/propane/tax card; meters UI
  REMOVED), AddUnitModal.tsx (Sub-metered utilities section: electric +
  water w/ optional sewer rate; batch-aware), UnitDetailPage.tsx
  (Sub-meters card = the meter edit surface).
- tenant: main.tsx (utilities nav/route removed), pages/UtilitiesPage.tsx
  DELETED.
- shared: METER_READING_DIGIT_OPTIONS/DEFAULT/modulus, METER_USAGE_
  ALERT_THRESHOLDS, METER_DOUBLE_CHECK_MIN/TOLERANCE, propaneSplitOptions
  + PROPANE_SPLIT_* , PAYMENT_ENTRY_DESCRIPTIONS +'PROPANE'.

## TESTS (green at close)
- utilityReadingRuns.test.ts 20/20: business-day walk-back, blind
  payloads (no values/priors/flags asserted by response-string match),
  verification tolerance (first read stands; 1252 re-read bills 250),
  replacement, auto-rollover 999822→000138=316 ($44.24), high-usage
  verified-by-re-read bills $840 w/ EMPTY landlord queue, escalation +
  swap resolve, random padding (1 suspect + 5 pads, suspect always in),
  4-digit wrap 9822→0138=316, capacity 400s, escape hatch, sewer ONE
  line item ($3.50, tax $0.10 = per-portion rates), read snapshots.
- propane.test.ts 8/8: fill math + tax, split gates, 4-way rounding
  (83.33×3+83.34 across consecutive cycles), acceleration (5 standalone
  payments, $420), settle-time redistribution (rent $800 → propane $270
  settled + rent $530 settled + $270 pending remainder; whole-row rule
  leaves $20 slivers on rent; second pass no-op), no-lease 400,
  cross-landlord 403.
- utility.test.ts 35/35, payments.test.ts 31/31, leaseLifecycle
  (invoice cron) 23/23. tsc clean: api, landlord, tenant.

## DEMO STATE (Sunset Palms, james@demo.dev)
July run OPEN 0/10, June 30 baselines (Row A 1000 → enter 001250 for
Grace's 250 kWh/$35 moment), no flags, no fills, no tax rates set.
Verification list generates when the 10th meter is read (expect ~6
random re-checks, then billing). seedDemo NOT yet updated for: digits
(defaults 6 — fine), propane/tax (absent — fine). Reseed-safe as is.

## KNOWN GAPS / NEXT SESSION
1. CONFIRM propane split boundaries: I encoded <25 none / 25-99 → 2 /
   100+ → 2 or 4 from Nic's phrasing — verify the 25-99 tier.
2. Tenant pay-flow UI doesn't yet display propaneNotice (response field
   exists) — small tenant-portal wire-up.
3. Stuck-run escape (/complete) is backend-only; unreadable-meter or
   abandoned verification blocks billing for that property/cycle.
4. Meter-setup read-only vs edit permission split still deferred (S532).
5. RUBS management UI no longer exists anywhere (meters list removed;
   unit surfaces are submeter-only). Backend intact. Surface when a
   RUBS property needs it — ask Nic where it should live.
6. US_FEDERAL_HOLIDAYS covers 2026-2027 (annual refresh cadence).
7. Landlord bills table shows tax but not reads (tenant-facing was the
   ask); trivial add if Nic wants it.
8. Nic's correction list continues next session; then W-56 work-trade,
   W-49/50 Checkr, W-42 agents last (unchanged order from S531/S532).

## SERVICES
Launch set only: API :4000, landlord :3001 (Claude preview), tenant
:3002, admin :3003, marketing :3004, POS :3005, admin-ops :3009,
Hermes :8080, embeddings :8081, Postgres :5432. Nic's Safari tabs
track :3001 — reload them via osascript after server restarts.
