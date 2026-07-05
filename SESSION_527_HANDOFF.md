# SESSION 527 HANDOFF

## Theme
Launch-prep mega-session, four arcs. (1) **Owner-defined unit subtypes + ONE
door for units** — S526's pre-baked subtype_key model replaced wholesale;
Add Property's bulk step killed; Add Unit gained quantity. (2) **Lease-overlap
guard** — reservations blocked by active leases (create + move) and the
schedule display bug hiding open-ended leases fixed. (3) **FlexDeposit audit**
— the custody rework we thought was pending was already DONE (S514); closed
the real residue (ACH-return pass-through on retries, poisonous stale
comments, DB write-guards). (4) **Demo world reseed + FINAL WALKTHROUGH
started** — Nic is walking the landlord portal and dictating a fix list;
31 items logged (W-1…W-31), fixing starts when he says the list is done.
Uncommitted (Nic commits).

## SHUTDOWN STATE (end of night)
- Mac shutting down: all portals + models die; tunnel (api.goldassetmanagement.com)
  dark until next start. Next session: start LAUNCH SET ONLY per
  [[gam-launch-portal-scope]] (models via `~/gam-start.sh models`, then API +
  landlord/tenant/admin/admin-ops/pos individually; marketing :3004 is launchd).
  Landlord :3001 should run under the Claude preview server (launch.json name
  `landlord`).
- 3 migrations applied this session: `20260703170000_property_unit_subtypes`,
  `20260703200000_drop_property_unit_type_pricing` (Nic OK'd the DROP),
  `20260703203000_flexdeposit_advance_columns_write_guard`. schema.sql regenerated.
- **DEMO WORLD REBUILT** — `apps/api/src/scripts/seedDemo.ts` (rerun:
  `node -r ts-node/register src/scripts/seedDemo.ts` from apps/api; wipes
  operational data, keeps ALL logins + staff perms, re-points Dana's lock).
  Old Mesa View/Oak Street demo data is GONE. New cast: Sunset Palms RV Resort
  (subtypes configured, bookings, change request, Marta's 35-night auto-draft
  lease), Oak Street Apartments (Studio/2BR subtypes; tenants in every payment
  state), Copper Canyon Homes (deliberately UNCONFIGURED for blank states).
  Tenants @tenant.dev/tenant1234: alice healthy · bob delinquent · carol
  expiring 21d · dan M2M · eva pending-signature · frank eviction · grace
  FlexDeposit custody 2/4 · henry mid-onboarding · iris bg-submitted · jack
  approved-in-pool.
- Tests at close: all affected suites green (units, units-gap-close,
  properties, properties-gap-close, s414-hygiene, bookings,
  schedule-property-scope, bookingLeaseDraft, publicBooking,
  propertyBookingFlow, flexDeposit, flexpay). Both apps tsc clean.

## THE ONE THING THAT MATTERS NEXT SESSION
**`FINAL_WALKTHROUGH.md` (repo root).** Nic resumes ADDING items when he
returns — do not start fixing until he says the list is complete. Protocol:
he calls items out, Claude logs W-<n> with context notes, NO fixes during
listing. 31 items so far; several are builds (W-2 rent roll page, W-7 renewal
form → lease draft, W-8 maintenance assign redo, W-20 schedule
self-compression) and two need discussion first (W-27 pending pool, W-31
"other deductions" circumstances). W-21's root cause is already analyzed in
the entry (lease end-cap uses exclusive check-out convention).

## SHIPPED

### 1. Owner-defined unit subtypes (Nic: "subtypes blank per landlord until they add them")
- `property_unit_subtypes` table (name + type-relevant facts: bedrooms/bath,
  RV layout/amp, storage size + 5 pricing fields; UNIQUE property/type/name).
  Old `property_unit_type_pricing` rows converted (field-merge applied) then
  table DROPPED. `units.subtype_id` (SET NULL on subtype delete).
- Routes: GET/POST(upsert)/DELETE `/properties/:id/unit-subtypes`; irrelevant
  facts nulled server-side by type. Shared: `PropertyUnitSubtype`,
  `unitSubtypeFactsLabel` (old resolveUnitTypePricing machinery deleted).
- `UnitSubtypesSection` replaces UnitTypePricingSection on PropertyDetailPage
  (old file deleted). Blank until owner adds; name + facts + pricing per row.
- **AddUnitModal**: type grid → OWNER'S subtype chips (or Custom = manual
  fields) → quantity 1-200 ("How many?") → pricing prefilled from subtype.
  Batch numbering continues after existing max ("RV 03, RV 04").
- **POST /units**: subtypeId (server merges facts+pricing; 404 foreign
  subtype), quantity (old bulk numbering logic), updates property unit_types,
  and FIXED a silent no-op: `status` was never accepted — Initial Status
  picker did nothing, every unit born vacant. Also formatUnitNumber acronym
  fix ("rv 12" → "RV 12", was "Rv 12").
- **Add Property step 2 (bulk Create Units) REMOVED** + its
  POST /:id/units/bulk endpoint. Create property → land on its detail page.
  S399/S414 bulk-hardening tests ported to the quantity path.

### 2. Reservations blocked by active leases + schedule truth
- POST + PATCH /units/:id/bookings now 409 on overlap with an ACTIVE lease.
  end_date treated as departure day (same-day turnover OK); NULL end = blocks
  forever; pending drafts don't block; a booking's own activated draft lease
  is exempt on PATCH (source_booking_id).
- **Display bug fixed**: schedule master query dropped NULL-end_date leases —
  M2M-occupied units looked EMPTY for months (Nic hit it moving a reservation
  "to an empty spot"). Backend range filter + 4 frontend null-endDate spots
  (bar painter, drag pre-check, reservations row, detail modal "ongoing").
- 5 new lease-guard tests in units.test.ts; scope-test fixture got a
  lease-free unit (its unit was unknowingly leased — same bug in miniature).

### 3. FlexDeposit: custody was ALREADY implemented (S514) — memory was stale
- Recon agent audit: service + all consumers custody-correct. Closed the gaps:
  (a) **real money fix** — retry pulls now carry the Stripe ACH-return
  pass-through (shared constant with FlexPay; settle path verified to credit
  custody only the fixed installment amount); (b) moveInBundle's 3 stale
  advance-era comments rewritten (one described a Connect Transfer that
  returns null); (c) CHECK write-guards on gam_advance_amount/balance_due_*
  (migration above); (d) ARCHIVED banner on legal/FLEXDEPOSIT_SLA_TEMPLATE.md;
  (e) CLAUDE.md + DEFERRED.md corrected to custody truth.

### 4. Walkthrough-flagged fixes shipped BEFORE the list protocol started
- Day-to-day manager: onsite managers now eligible (union of both scope
  tables, dedup, backend validation matches; role tags later removed — Nic:
  "an on site manager would be a pm"); empty state got note + gold Team
  button. 4 tests.
- Unit detail page: type-appropriate facts (RV layout/amp, storage size — no
  bedrooms on RV spots); listing form bed/bath gated by type.
- LeasesPage tenant column: read the tenants[] array (flat fields never
  existed → every lease showed "—"); bill-fee modal too.
- Buttons: gold=action / gray=cancel-only STANDING RULE (memory saved);
  existing violations batch to cosmetics.

## DECISIONS / RULES CAPTURED (memory files updated)
- gam-simplicity-principle (STANDING): simplest platform-wide; flexibility =
  per-property; never surface internal distinctions users don't act on.
- gam-button-color-rule (STANDING): gold btn-primary actions; ghost only
  cancel/close/back.
- PM portal → launch feature: Nic LEANING yes (design ≈ landlord). PENDING —
  nothing unhidden; drags Stripe Connect KYC + PM money flows into launch
  scope if confirmed.
- Walkthrough protocol: landlord list first, all other launch portals get the
  same treatment AFTER.

## FILES TOUCHED (majors)
- apps/api: routes/properties.ts (subtypes CRUD, manager endpoints, bulk
  removed), routes/units.ts (POST rework, lease guard, master query),
  services/flexDeposit.ts (retry fee), jobs/moveInBundle.ts (comments),
  lib/format.ts (acronyms), scripts/seedDemo.ts (NEW), 3 migrations,
  tests: units, properties-gap-close, s414-hygiene, schedule-property-scope,
  properties.
- apps/landlord: pages/AddUnitModal.tsx (rewrite), UnitSubtypesSection.tsx
  (NEW; UnitTypePricingSection.tsx DELETED), PropertiesPage.tsx (wizard
  removed), PropertyDetailPage.tsx (manager card, subtypes section),
  UnitDetailPage.tsx (type facts, listing gate), SchedulePage.tsx (null
  endDate handling), LeasesPage.tsx (tenants[] fix).
- Repo root: FINAL_WALKTHROUGH.md (NEW — the live list), DEFERRED.md
  (FlexDeposit entry rewritten to custody), CLAUDE.md (FlexDeposit truth).

## DEFERRED / OPEN
1. **FINAL_WALKTHROUGH.md W-1…W-31 — the whole fix backlog. Nothing fixed yet
   by design.** More items coming when Nic returns.
2. PM-portal launch promotion — Nic decision pending.
3. Cosmetic batch: ghost→gold sweep, "+ Book" on lease-covered units,
   schedule toolbar above non-timeline tabs.
4. S526 leftovers still open: staff-accept auto-login; legacy pre-catalog
   permission keys on schedule routes.
5. Stripe BLOCKED on Nic's sales rep. FlexDeposit retry-fee path has no
   Stripe-mocked test (pull path untested infra-wise — noted, not built).
6. Old advance-era `flexpay_advances` naming + FLEXPAY_ACH_RETURN_FEE constant
   reconcile-to-live-fee-schedule note (in code comment) — post-Stripe.

## NEXT SESSION
1. Start launch set only (see shutdown state).
2. Open FINAL_WALKTHROUGH.md, re-read the protocol note, wait for Nic to
   continue dictating items. Log, don't fix.
3. When Nic closes the list: propose a fix order (quick wires → bugs →
   builds → discuss items), get his sign-off, then execute batch by batch.
