# SESSION 549 HANDOFF
(code comments from the later phases are tagged "S550" — same chat
session, one handoff; next session is 550.)

## Theme
BIG session, eight shipped phases, all Nic-directed in sequence:
(§1–3) periodic inspection VERDICT LOOP — front desk passes or flags
a tenant-submitted periodic; flagging auto-schedules an in-person
inspection. (§4) tenant signature = MOVE-IN ONLY, hard — periodic is
SUBMITTED (portal login IS the attestation), move-out is staff-
conducted; new /submit route. (§5) inspections PROPERTY-LOCKED —
landlord sees all, staff only assigned properties. (§6–7) dwelling-
ownership inspection CATALOG — subtype-level tenant-owned vs park-
owned MH/RV drives site-only vs interior checklists; bathrooms/
kitchen/living-dining sized to real unit facts; tenant on-the-go
"Spot something wrong?" findings. (§8) CONDITIONAL LEASE FEES — the
carpet clause generalized: parser detects "if not X, then $Y",
every-dollar audit guarantees no missed financial liability, fees
charge ONLY when the move-out walkthrough assesses the condition
failed. Everything tested + live-verified in browser (Dana + Alice).

## 1. Flag-suspicious verdict (routes/inspections.ts)
- POST /api/inspections/:id/flag-suspicious (requirePerm
  inspections.manage; body { reason: min 3 chars }). Guards: periodic
  only, tenant-submitted only (tenant_id set), not finalized/cancelled,
  not already flagged.
- One tx: the flagged record goes status='cancelled' (photos preserved
  read-only, NO credit events) + flagged_suspicious_at /
  flagged_by_user_id / flag_reason / followup_inspection_id; the
  follow-up is created via insertInspectionWithChecklist (same seeding
  as every other creation path): type periodic, status draft,
  **tenant_id NULL on purpose** — staff-conducted, so the landlord/
  inspector signature alone reaches landlord_signed and an adversarial
  tenant can't stall the loop. comparison_inspection_id ← the flagged
  submission (photos side-by-side for the inspector). scheduled_for =
  addBusinessDays(today, 3) (S548 helper, US federal holidays skipped).
- Migration 20260719120000: 4 nullable columns on unit_inspections,
  no backfill.

## 2. Notifications (createNotification, best-effort post-commit)
- Landlord + property-assigned staff (property_manager_scopes ∪
  onsite_manager_scopes, same shape as scheduleMoveOutInspections):
  type 'inspection_flagged_suspicious' WITH the reason + visit date,
  actionUrl to the follow-up. The flagger is skipped.
- Tenant: type 'inspection_scheduled', NEUTRAL copy only — visit date,
  "a member of the property staff will conduct it". The word
  "suspicious" and the reason never reach the tenant (blind-entry
  spirit); GET /:id and the list REDACT all four flag columns for the
  tenant role (tested).

## 3. Surfaces (landlord portal)
- InspectionDetailPage: "Review tenant submission" verdict card on
  un-flagged tenant-submitted periodic inspections (pass = sign +
  finalize, or red "Flag as suspicious"); in-app FlagModal (reason
  textarea, no native dialogs); red flagged banner with reason +
  "Open in-person inspection →"; header badge shows "Flagged
  suspicious" instead of the cancelled status.
- InspectionsPage list: "Flagged suspicious" badge overrides the
  status badge on flagged rows (API list now returns
  flagged_suspicious_at + followup_inspection_id).

## Decisions (made this session — flag to Nic if wrong)
- Flagged record is CLOSED (cancelled + flag metadata), not left open;
  the in-person follow-up is the live workflow.
- Follow-up carries no tenant_id (see §1) — tenant gets notice via
  notification, not a portal row.
- Follow-up lands 3 business days out; staff can Reschedule on the
  detail page as usual.

## 4. Tenant signature = MOVE-IN ONLY, HARD (Nic, same session —
## also resolves the recon question about the S548 deposit-return stall)
- Rule: the tenant signs the MOVE-IN inspection ONLY — certifying they
  took the photos, everything is correct to their knowledge, issues in
  the notes. Nothing else, ever. Being authenticated in their own
  portal IS the attestation everywhere else. Move-out/periodic are
  staff-conducted under the legally required entry notice — the tenant
  gets notice, not a veto.
- Sign route: tenant signing on any non-move-in type is 409'd; and
  tenantRequired = tenant_id set AND type='move_in', so the landlord/
  inspector signature alone reaches landlord_signed on periodic/
  move-out/turnover — the S548 deposit-return gate can never be
  stalled by a departed tenant.
- NEW POST /api/inspections/:id/submit — the signature-less "I'm done"
  for the self-directed periodic: tenant-only, own inspection, periodic
  only, draft only, ≥1 photo required. Sets status='tenant_signed'
  (same status the verdict queue reads — no schema change) + stamps
  conducted_at, writes NO signature row, notifies the responsible party
  (type 'inspection_submitted').
- Labels: 'tenant_signed' on a periodic DISPLAYS as "Submitted" /
  "Submitted for review" (inspectionStatusLabel in landlord
  InspectionsPage, statusLabel in tenant main.tsx — per-type label
  maps, no raw enum). Move-in still shows "Tenant signed".
- Tenant portal cards: move_in = sign card (unchanged); periodic
  draft = "Submit walkthrough" card (disabled until a photo exists),
  submitted = green confirmation; move_out = NO card at all.
- Landlord: tenant sign-off panel "Not required" + explainer on
  non-move-in; list footer + status-filter copy updated; agent
  profile TENANT_INSPECTION_ROUTING updated (move-in/periodic guided
  walkthrough, submit-not-sign wrap-up; move-out removed).
- Tests: +5 total for S550 (sign-alone finalize ×2; tenant sign 409 on
  periodic/move-out; submit happy path incl. no-signature-row assert +
  notification; submit guards). Suite 65/65 + profiles green; tsc
  clean api/landlord/tenant. Browser-verified: Alice submitted a
  periodic (badge SUBMITTED, no sign card) → landlord list shows
  "Submitted for review" → james@demo.dev notified.
- Demo row: Alice / Apt 201 periodic left in 'Submitted for review'
  for the front-desk verdict walkthrough.
- (The property-lock observation below was FIXED in §5 the same
  session.)

## 5. Inspections property lock (Nic, same session)
- Rule: the LANDLORD sees everything; team members see only their
  assigned properties. Enforced via getScopedPropertyIds (the S526
  helper — null for owners/all_properties, else the property_ids list)
  at every inspections entry point: list (filter), loadInspectionRow
  (detail/sign/items/photos/videos/flag/submit/PATCH — now joins units
  for property_id), POST create, unit lifecycle, and video-files
  streaming (uploader + admin bypass kept). Verified live: Dana
  (Sunset Palms-locked) no longer sees the Oak Street rows.
- Test note: a worker token with NO scope row now reaches nothing —
  suites minting worker tokens for inspections must seed a
  *_scopes row (see the S549 PM notification test, fixed this way).

## 6. Dwelling-ownership inspection catalog (Nic, same session)
- NEW units.dwelling_ownership ('landlord'|'tenant', default
  'landlord'; migration 20260719160000 backfills rv_spot → 'tenant'
  so existing behavior is unchanged). Shared: DWELLING_OWNERSHIP_VALUES
  + label map.
- buildInspectionChecklist is THE master derivation (single source),
  now (unitType, bedrooms, dwellingOwnership) →
    rv_spot tenant → site only; rv_spot landlord → site + NEW
    RV_UNIT_INSPECTION_AREAS (rig interior/kitchenette/bath/systems/
    exterior — an RV NEVER gets bedrooms);
    mobile_home tenant → NEW MH_SPACE_INSPECTION_AREAS (lot/hookups/
    yard only — never inside the tenant's home);
    mobile_home landlord → full residential w/ REAL bedroom count;
    apartment/single_family → unchanged (bedrooms = actual, cap 4).
- Wired through EVERY consumer: insertInspectionWithChecklist (+ its
  callers: create route, flag follow-up, agent create_inspection),
  agent get_inspection_checklist / get_inspection_progress
  (inspectionChecklistShared), and the S548 move-out scheduler —
  which also got a FIX: it raw-inserted with NO checklist items;
  it now seeds via the same shared path.
- Surfaces: AddUnitModal "Who owns the RV?/home?" pill (rv_spot
  default tenant, mobile_home default park-owned, helper text says
  what inspections will cover); SchedulePage unit-config modal
  ownership select (PATCH /units/:id/type persists it).
- Tests: +7 (2 property-lock, 5 catalog: tenant/park RV, tenant/park
  MH, 4-bedroom single_family). Suite 72/72; bookingLeaseBilling +
  units suites green.

## Demo rows left ON PURPOSE (walkthrough)
- Grace / RV 08 at Sunset Palms: flagged periodic inspection
  (764570d3…) + its in-person follow-up scheduled 2026-07-22.
- Dana (testdesk-demo@golddoor.io) granted inspections.view +
  inspections.manage (onsite_manager_scopes) — she's the front-desk
  verdict demo user. NOTE: permission grants only take effect at next
  login (packed into the JWT).

## 7. Ownership → SUBTYPE + thorough checklists + on-the-go findings
## (Nic, same session — corrections to §6)
- Ownership is a SUBTYPE-level fact: property_unit_subtypes.
  dwelling_ownership (migration 20260719180000; NULL = type default).
  Subtype editor (UnitSubtypesSection) has the "Who owns the RV/home?"
  select for rv_spot/mobile_home; units minted from a subtype inherit
  it. Precedence at unit create: body > subtype > type default.
- DEFAULT FLIPPED: mobile_home now defaults TENANT-owned (parks mostly
  don't own the homes) — migration backfills existing mobile_home
  units to 'tenant'; AddUnitModal defaults tenant for both RV + MH;
  park-owned rental is the explicit exception.
- Checklist thoroughness: buildInspectionChecklist now also takes
  bathrooms — ONE AREA PER REAL BATHROOM (ceil; 2.5 baths → Bathroom
  1, 2, 3 (half); single bath stays plain 'Bathroom'; cap 4), spliced
  for EVERY interior-inspected type (hotel_room included). 'Living /
  common' renamed 'Living / dining' + Dining area item. bathrooms
  passed through all consumers (create/flag/agent tools/scheduler).
- On-the-go findings: tenant detail page "Spot something wrong?" card
  (draft only) — type "bedroom window is broken" → POST /:id/items
  {area:'Reported issues', condition:'damaged'} → camera auto-opens
  and the photo attaches to THAT item (photoMut now carries itemId).
  Landlord side already had the ad-hoc add row. Agent copy updated
  (points tenants at the box; bathroom mapping example "Bathroom 1").
- FIXED pre-existing red suite: s414-hygiene POST /units tests had
  been 422ing since the S537 late-fee gate (fixture never seeded
  decisions) — fixture now seeds rv_spot+apartment decisions, 12/12.
- Tests: +6 (ownership defaults + subtype inheritance in
  units-gap-close; bathroom sizing, kitchen/living-dining coverage,
  tenant ad-hoc finding in inspections). Suites green: inspections 75,
  units-gap-close 34, units, properties, properties-gap-close,
  s537-late-fee, s414-hygiene 12, bookingLeaseBilling. Live-verified:
  Alice typed the issue → checklist row DAMAGED + camera prompt.
- Demo rows: Alice has a NEW draft periodic (3045f9b4…) with the
  'Reported issues' finding, left for walkthrough.

## 8. CONDITIONAL LEASE FEES — carpet clause generalized (Nic, same
## session; closes S548 next-phase #1). lib/pdfText untouched.
- Schema (migrations 20260719200000/200100/200200): lease_fees +
  condition_text (the clause VERBATIM — lease-is-law), condition_result
  (NULL until a human assesses; 'met'|'failed'), condition_assessed_at/
  _by; unit_inspection_items.lease_fee_id (ON DELETE SET NULL) links a
  checklist item to the fee it assesses.
- **Sweep rule (the point)**: services/depositReturn.ts cleaning-fee
  sum now excludes rows with condition_text set UNLESS
  condition_result='failed'. Unassessed or met = never charged.
- **Parser** (extractors.ts + index.ts, sentence-scoped over body
  prose): detectConditionalFees — clause has $ amount + conditional/
  obligation language ("failure to", "if tenant does not", "will be
  charged/assessed/forfeited", "required to … or/else") → 
  ParserExtractedConditionalFee {label, amount, conditionText,
  confidence}. Two-sentence clauses handled (the $ lives in "Failure
  to do so…" — preceding clause pulled in for label/context). Labels
  keyword-derived (Carpet cleaning / Smoking violation / Keys / Yard
  upkeep / …). Late-fee + "Security Deposit:" + rent clauses excluded
  (dedicated extractors own them; exclusion is the LABELED deposit
  form only — conditional clauses legitimately say "deducted from the
  security deposit").
- **Every-dollar audit** (Nic: "parser must handle every financial
  liability"): auditUnattributedAmounts — every $ in the body not
  attributed to rent/deposit/late-fee/detected-conditional-fees emits
  a confirm-severity 'unattributed_amount' flag (new category) with
  the clause, so NO financial obligation slips through silently.
- **Resolve**: resolveIntent writes each landlord-confirmed
  conditional fee as lease_fees (fee_type other_fee, due_timing
  move_out, condition_text). ConfirmIntentModal got a "Conditional
  fees (from the lease)" section — clause + amount + Remove (prunes
  false positives; wholesale-replace override like the entity arrays).
- **Assessment loop**: insertInspectionWithChecklist appends one
  'Lease conditions' item per UNASSESSED conditional fee on move-out
  inspections (label "<desc> — $X if not met", notes = clause,
  lease_fee_id set) — all creation paths inherit (route, scheduler,
  agent). At move-out FINALIZE (same tx as the status flip):
  good/fair → 'met', damaged/missing → 'failed', na stays NULL.
- Tests: conditionalFees.test.ts NEW (7 — canonical two-sentence
  carpet clause, keys, multi-obligation, exclusions, audit);
  depositReturn +2 (unassessed excluded / failed sweeps);
  inspections +2 (item seeded w/ lease_fee_id; finalize writes
  met/failed/NULL). Regression green: landlords-gap-close,
  leases-gap-close, bookingLeaseBilling, depositReturn 19,
  inspections 77. tsc clean api+landlord.
- NOT done (batch/UI): DepositReturnPage doesn't yet LIST conditional
  fees with their met/failed state (the sum is right; the per-line
  display joins the S537 remittance-display carryover). Manual
  conditional-fee entry outside import (lease drafting flow) — future.

## NEXT PHASES
1. **Storage abandonment/auction workflow** (own session).
2. Carryovers: storefront prod wiring, FlexPay OCR, Nic-gated
   Stripe/Checkr/DoorLoop. UI batch: flagger name on flagged banner;
   DepositReturnPage conditional-fee line display.

## Files touched (S549/S550)
api: routes/inspections.ts (flag + submit routes, flag columns +
tenant redaction, move-in-only tenant signing, property lock at every
entry point, dwelling ownership pass-through), routes/units.ts
(dwellingOwnership on create + PATCH /:id/type), services/
inspections.ts (dwellingOwnership param), services/moveOutInspections.ts
(scheduler now seeds checklist via shared path), services/agents/
profiles.ts (walkthrough copy), agents/tools: createInspection,
getInspectionChecklist, getInspectionProgress,
inspectionChecklistShared (ownership in unit facts),
routes/inspections.test.ts (+16 tests). shared: DWELLING_OWNERSHIP_*,
RV_UNIT_INSPECTION_AREAS, MH_SPACE_INSPECTION_AREAS,
buildInspectionChecklist ownership rules. landlord:
InspectionDetailPage.tsx, InspectionsPage.tsx, AddUnitModal.tsx
(ownership pill), SchedulePage.tsx (unit-config ownership select).
tenant: main.tsx (+ Spot-something-wrong card, itemId photo link).
Also §7: api routes/properties.ts (subtype dwellingOwnership),
routes/units-gap-close.test.ts (+2), routes/s414-hygiene.test.ts
(fixture fix); landlord UnitSubtypesSection.tsx.
Also §8: api jobs/leaseParser/extractors.ts (detectConditionalFees +
auditUnattributedAmounts + clause chunking), jobs/leaseParser/index.ts
(output + flags + every-dollar audit), jobs/leaseParser/resolveIntent.ts
(lease_fees conditional writes), jobs/leaseParser/conditionalFees.test.ts
(NEW — the parser's first test file), services/depositReturn.ts (sweep
exclusion) + depositReturn.test.ts (+2), services/inspections.ts
('Lease conditions' item seeding), routes/inspections.ts (finalize
assessment writeback) + test (+2); shared
ParserExtractedConditionalFee + 'unattributed_amount' flag category;
landlord ConfirmIntentModal.tsx (conditional-fees review section).
Migrations (ALL applied — verify:
`psql gam -c "SELECT filename FROM schema_migrations ORDER BY filename
DESC LIMIT 6"`):
20260719120000_periodic_inspection_suspicious_flag.sql,
20260719160000_units_dwelling_ownership.sql,
20260719180000_subtype_dwelling_ownership_mh_default.sql,
20260719200000_lease_fees_conditional.sql,
20260719200100_inspection_items_lease_fee_link.sql,
20260719200200_inspection_items_lease_fee_set_null.sql.

## Demo rows left ON PURPOSE (walkthrough)
- Grace / RV 08 Sunset Palms: flagged periodic (764570d3…) + in-person
  follow-up scheduled 2026-07-22.
- Alice / Apt 201 Oak St: SUBMITTED periodic (5cc70eab…) awaiting
  front-desk verdict + a draft periodic (3045f9b4…) with a
  'Reported issues — Bedroom window is cracked' DAMAGED finding.
- Dana (testdesk-demo@golddoor.io / testdesk-demo) now holds
  inspections.view + inspections.manage; her list is property-locked
  to Sunset Palms (the Oak St rows above are invisible to her — owner
  sees them under james@demo.dev).

## Watchouts
- Suite counts at close (all green): inspections 77, depositReturn 19,
  conditionalFees 7, units-gap-close 34, s414-hygiene 12 (FIXED — was
  5 red since the S537 late-fee gate; fixture now seeds decisions),
  units, properties(+gap-close), s537-late-fee, landlords-gap-close,
  leases-gap-close, bookingLeaseBilling. tsc clean api/landlord/tenant.
- Worker tokens in inspection tests MUST seed a *_scopes row now — the
  S550 property lock makes a scope-row-less worker see NOTHING.
- Tenant redaction of flag columns is response-shaping in the route
  (delete/omit), not column-level — new endpoints joining
  unit_inspections must repeat it.
- The staff/landlord recipient union query exists in TWO places
  (scheduleMoveOutInspections + flag route) — third consumer should
  extract a shared helper.
- addBusinessDays pulls US_FEDERAL_HOLIDAYS from jobs/autoPayouts —
  seeded 2026–2027, annual refresh.
- unit_inspection_items.lease_fee_id is ON DELETE SET NULL (fix-forward
  20260719200200) — cleanupAllSchema's delete order depends on it.
- Conditional-fee semantics: condition_text set = NEVER charge unless
  condition_result='failed'. Do not add billing paths that read
  lease_fees due_timing move_out/other without repeating the exclusion
  (only services/depositReturn.ts sums them today; bill-fee is
  explicit-input, monthly/move-in paths don't touch these timings).
- The 'Lease conditions' area only exists on move-out inspections with
  a lease; compareMoveOutToMoveIn ignores it (no move-in counterpart).
