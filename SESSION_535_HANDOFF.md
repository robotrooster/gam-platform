# SESSION 535 HANDOFF

## Theme
The template/late-fee legal architecture, built live to Nic's spec in
one sitting: cross-template renewals, per-unit-type templates + late
fees (NO property default), property-locked templates with upload
auto-detection, and the document-first enforcement rule (courts read
the document, not the config). Also: renewal rent presets, the '-' =
month-to-month convention, and identity-field locking. COMMITTED +
PUSHED at close (Nic-initiated).

## THE LEASING MODEL AS IT NOW STANDS
1. TEMPLATES carry unit_type (required choice at upload; 'all' =
   universal NULL) and an optional PROPERTY LOCK (property_id). Upload
   reads the PDF text (services/templatePropertyDetect.ts) and
   auto-suggests the lock on a UNIQUE property name/address match
   (ambiguous = no suggestion). Cards show "N fields · N pages · type ·
   property".
2. DRAFTING resolves everything from the UNIT: pickers (renewal modal +
   send modal) list only compatible templates (type + property, plus
   NULLs) and auto-select the most specific (property+type exact →
   type → property → universal; prior template first on renewals if
   still compatible). The API independently 400s incompatible pairings
   (renewal POST + POST /documents) — a PM cannot send the wrong form
   even through a UI bug.
3. LATE FEES are locked to (property, unit_type) rows ONLY —
   property_unit_type_late_fees, resolver services/lateFeePolicy.ts.
   NO property-wide default (Nic: a blanket default can be an illegal
   charge for an unvetted class), NO per-lease values, NO predecessor
   carry-over on renewal. properties.late_fee_enabled remains the
   master toggle; the old properties.late_fee_* value columns are
   legacy (no reader in the resolver; lateFees.ts billing still reads
   the LEASE snapshot = what the tenant signed).
4. Doc creation stamps late-fee fields: baseline 'N/A' on ALL 11
   late-fee tags, resolved policy overlays. WRITABLE spec parses are
   numeric-guarded ('N/A'/'-'/junk = absent); no end/'-' also forces
   lease_type month_to_month.
5. DOCUMENT-FIRST GUARD (Nic: "court action only goes by the actual
   document"): drafting an original_lease REFUSES when the resolved
   policy produces values the template can't display (missing late-fee
   fields / templateless manual doc) — error names the missing field
   labels. Chain: policy → printed on doc → signed → lease snapshot →
   billed. Config never bills what the tenant didn't sign.
6. SIGNING UI: late-fee fields locked (policy popup w/ exact fee-start
   day: due day + grace; a no-policy class shows the "no late fees —
   set a policy" popup). IDENTITY fields (tenant/unit/property) locked
   when stamped — unit is the RECORD (doc.unit_id), never typed.
   Legacy docs with EMPTY late-fee/identity fields stay editable (no
   dead-ends). RENT field on renewals shows quick presets (Keep / +3% /
   +5% / +10% computed from carried rent; flat = type below).
   END-DATE editor has "Month-to-month — no end date (enters '-')" +
   explainer. Landlord-sign completeness gate (moved from /send in the
   cross-template work): landlord-role tagged fields may be empty at
   send; the landlord's sign submit 400s until every tagged field is
   filled — value-bearing fields are force-required in their signing
   UI so the counter agrees.
7. CROSS-TEMPLATE RENEWAL (the S534 saved idea, DONE): renewal prefill
   covers every derivable column (identity, terms, term dates mirrored,
   rent = current, per-TYPE deposits incl. pet/key/cleaning, recurring
   fees, utility responsibilities as 'tenant'/'landlord', lease_type).
   M2M predecessor prefills end_date '-'. Late fees excluded by design
   (come from policy). Deposit overlay scoped to fee_type
   security_deposit; carried_rent added to sign GET for the presets.

## OTHER FIXES THIS SESSION
- SignPage (both portals): failed sign no longer shows the SUCCESS
  screen (response {success:false} was swallowed) — errors alert and
  stay on the doc. allDone reads data.completed correctly.
- GET /esign/templates: ?unitType= + ?propertyId= compatibility
  filters; property_name joined.
- Lease responses now include unit_type + property_id (renewal modal
  needs them; 5 queries in leases.ts).
- PropertyLateFeeSection (NEW, on PropertyDetailPage): toggle +
  per-unit-type rows + grace popup (engine-exact math: fee fires at
  due_date + grace_days → due 1st + 5 grace = starts the 6th).
- uploads lockdown (task chip, ran separately) reconciled: static
  serving is /uploads/public + /uploads/unit-photos only; demo template
  PDFs live in uploads/public; both demo templates' base_pdf_url
  updated; seed scripts write uploads/public.

## MIGRATIONS APPLIED (3 this session, in order)
20260709110000_lease_templates_unit_type ·
20260709120000_property_unit_type_late_fees ·
20260709130000_lease_templates_property_lock.
(A 20260709100000 version of the late-fee table was written and
DELETED BEFORE APPLYING when Nic redirected to template-per-type, then
restored as 120000 when he clarified he wanted BOTH. Never applied
twice; schema_migrations is clean.)

## TESTS (green at close)
esign 92/92 (new: cross-template gate move + prefill coverage,
unit-type pairing, property-lock pairing, per-type late-fee stamping
[N/A default / override wins / no-carry], document-printability guard,
'-' month-to-month execution) · esign-templates 19/19 ·
templatePropertyDetect 4/4 (NEW suite) · leases 59/59 ·
leaseLifecycle 23/23 (from S534 half) · utilityReadingRuns 25/25 ·
propane 9/9 · payments 31/31 · utility 35/35. tsc clean: api,
landlord, tenant.

## DEMO STATE (james@demo.dev)
- Templates: "Standard Residential Lease" (universal, unlocked, NO
  late-fee fields) · "Updated Residential Lease (2026)" (apartment,
  LOCKED to Oak Street, binds late fees/deposits/utilities;
  uploads/public/updated-form-2026.pdf via
  scripts/seedUpdatedTemplateDemo.ts — rerun after reseeds).
- Oak Street: late_fee_enabled + APARTMENT row $15/5-day (per-type,
  seeded to match existing lease snapshots). Carol Vasquez Apt 202:
  $500 deposit (fee row + funded sd row), open CROSS-TEMPLATE renewal
  draft 6399758a on the Updated form (5/6→ now more fields; unsigned).
  NOTE: drafting an Oak Street apartment on "Standard" now 400s (no
  late-fee fields) — that's the printability guard working; good demo.
- Sunset Palms: NO late-fee rows (no fees for RV class), July meter
  run still OPEN 0/10, Henry Park parsed intent in Pending Pool.
- S534 demo pieces intact (parser review w/ highlights, deposit
  overlay, utilities decoupling).

## KNOWN GAPS / NEXT
1. properties.late_fee_* legacy value columns: unread by the resolver
   but still written by the PATCH route + old UI paths — candidate for
   a cleanup migration once Nic confirms the per-type model sticks.
2. Landlord bills table / S533 leftovers unchanged (RUBS UI absent,
   meter permission split, US_FEDERAL_HOLIDAYS 2026-27).
3. /uploads security chip DONE (separate task); verify avatars/docs
   flows in a normal walk sometime.
4. Deposit reduction at renewal = manual partial return (by design).
5. FlexDeposit custody rows don't rebind on renewal (excluded by
   design) — check when touching FlexSuite.
6. Then: W-56 work-trade, W-49/50 Checkr, W-42 agents (order stands).

## SERVICES
Launch set (API :4000, landlord :3001 [preview-managed this session],
tenant :3002, admin :3003, marketing :3004, POS :3005, admin-ops
:3009, Hermes :8080, embeddings :8081, Postgres :5432).
