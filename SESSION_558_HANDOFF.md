# SESSION 558 HANDOFF — smooth lease onboarding + deposit/late-fee/lease derive-from-document + utilities RUBS/flat-rate rebuild (ALL DEPLOYED LIVE)

Big build session, Nic-driven. Theme: make everything **derive from the signed
lease / the meter reality** (not drifting settings), and make the onboarding +
utilities workflows smooth. Everything below is BUILT, TESTED, and DEPLOYED to
the live self-host (API rebuilt + com.gam.api restarted several times; frontends
are Vite dev → live via HMR; migrations applied to the live DB). Next: 559.

Prod API restart gotcha bit us again (orphan on :4000 → old code serves while
launchd's instance crash-loops). Clean procedure that works:
`lsof -tiTCP:4000 -sTCP:LISTEN | xargs kill -9; sleep 2; <verify empty>; <poll for 401>`.

## SHIPPED

### 1. Deposit derives from the LEASE TEMPLATE, not a property setting
- Migration `..._deposit_months_on_template.sql` — `lease_templates.deposit_months`.
  REMOVED the S556 `property_unit_type_deposits` table + its 3 `/deposit-multipliers`
  routes + `PropertyDepositSection.tsx`. Deposit = unit rent × template.deposit_months,
  stamped on the drafted lease (swap template → multiplier follows → always matches
  the signed doc). `services/depositPolicy.ts` → `resolveDepositMonths(templateId)`;
  `leasePrefill.ts` threads templateId; ESignPage send-form passes `?templateId`.
  Template modal got a "Security Deposit" dropdown. NULL months → deposit box left
  blank (never invent a deposit). Tests: esign 106.

### 2. Template = the per-unit-type config carrier
- `lease_templates.default_term_months` (NULL = month-to-month; N = fixed N-mo) +
  `is_unit_type_default` + `POST /esign/templates/:id/set-default` (radio-clears the
  prior default for landlord+unit_type+property). `services/templateResolve.ts →
  resolveDefaultTemplateForUnit(unitId)` (property-locked default wins). Migrations
  `..._template_default_term_months`, `..._template_unit_type_default`,
  `..._drop_template_default_unique_index` (the partial unique index collided with
  ON DELETE SET NULL on property delete — route-level radio-clear enforces it now).
  Template UI: default-term dropdown + "Make default" button + Default badge.

### 3. Smooth manual lease onboarding — the pipeline ([[gam-smooth-onboarding-pipeline]])
TWO flows (Nic): (A) import existing paper (onboard-tenant, unchanged) vs (B)
NEW lease e-sign (reused for bg-checked prospects — Checkr gate just sits in front).
Built Flow B:
- `POST /landlords/me/onboard-new-lease-tenant` — unit-linked invite (no lease row),
  gated on unit rent set + late-fee decision + occupancy cap; whole_unit stale-draft
  auto-void repair. Writes `pending_tenant_intents`(unit-bound) + invite email.
- accept-invite (tenants.ts) stamps `pending_tenant_intents.accepted_at` + best-effort
  `autoDraftLeasesForUnit` in its own tx.
- `services/leaseOnboarding.ts` — `assertUnitCanAcceptNewLease` (occupancy cap) +
  `autoDraftLeasesForUnit`: whole_unit → ONE shared lease when the whole roster
  accepts (primary + co_tenant_1..3, max 4); by_room → one single-tenant lease per
  accepted person. Reuses **exported** `createDocumentRecord` (esign.ts) which fills
  rent/deposit from unit+template; the service supplies term dates.
- Frontend: "New Lease — Invite to Sign" card + form in TenantOnboardingPage.
- Migrations: `pending_intent_pipeline_state` (accepted_at + draft_document_id).
- Tests: leaseOnboardingPipeline.test.ts (6) — onboard, rent-gate, occupancy 409,
  whole_unit shared draft, by_room stacking + cap, add-3rd-co-tenant repair.

### 4. Occupancy mode (whole_unit / by_room) — property DEFAULT, unit AUTHORITATIVE
- `units.occupancy_mode` ('whole_unit' default | 'by_room'; cap 2×bedrooms) +
  `properties.default_occupancy_mode` (SEEDS new units at create; NOT a governing
  setting — the unit owns it). Shared `OCCUPANCY_MODES` + `BY_ROOM_LEASES_PER_BEDROOM=2`.
  UI: property "Default occupancy for new units" card + per-unit "Leasing" toggle
  (`PATCH /units/:id/occupancy-mode`, guards switching to whole_unit while >1 active
  lease). Migrations `units_occupancy_mode`, `property_default_occupancy_mode`.
- Void rule (esign.ts ~2597): blocks only on a TENANT-role signature — a
  landlord-only-signed draft stays voidable (landlord signs first; binds no one).
  Makes the mid-roster repair path work.

### 5. Late fees: LOCKED + PURE lease-stamp billing ([[gam-late-fee-consistency]])
- System stays per-(property,unit_type) policy (Nic considered moving to template,
  decided NO). Change: (a) value force-stamped server-side already; (b) template
  editor now LOCKS any field bound to a late-fee lease_column — no drag/resize/
  delete, 🔒 badge, read-only notice (shared `LATE_FEE_LEASE_COLUMNS`+`isLateFeeColumn`).
- **Billing → PURE LEASE-STAMP (Nic-decided, SUPERSEDES the tenant-favorable
  ceiling).** `jobs/lateFees.ts` removed the policy ceiling (+ policyScheduleTotal +
  the resolveLateFeePolicyForUnit call). A policy change (lower / no-fee / delete)
  now has ZERO effect on existing leases — the document is the charge; a mid-lease
  change needs a superseding lease. Tests flipped in s537-late-fee-consistency (20).

### 6. Utilities: RUBS metered-exclusion (UNIT-DRIVEN) + flat-rate + config UI
([[gam-rubs-submeter-exclusion]]) — utility-neutral (water/gas/electric).
- **RUBS exclusion is UNIT-DRIVEN (Nic redesign, "melted butter").** Assign every
  unit a master feeds to its group; any served unit with its OWN same-utility
  submeter is auto-excluded (billed on its submeter + subtracted from the pool),
  the rest split the remainder. NO manual link — `rubs_parent_meter_id` was added
  (`..._rubs_submeter_exclusion`) then DROPPED (`..._drop_rubs_parent_meter_id`);
  `utilityBilling.ts` derives it from `utility_meter_units`.
- **flat_rate** billing method (`..._utility_flat_rate` extends the CHECK) — fixed
  $/unit, no reading, own line item (e.g. trash).
- **RUBS invoice gate** (`jobs/invoiceGeneration.ts`) — a RUBS-group unit's WHOLE
  invoice holds until the master AND every submeter on the master's units are read
  (+ needs_review flags). Was "RUBS never blocks" before — a real gap Nic caught.
- Submeter capped to ONE unit (UI + `POST /meters/:id/units` guard).
- Meter-config UI: new "Meter Setup" section in UtilityMetersPage (MeterConfigSection
  + AddMeterModal) — add master/submeter/flat/master-bills-landlord, assign the RUBS
  group with 🔌 submetered / splits tags, no link step.
- Tests: utilityBilling 28, utilityReadingRuns 27, utility 35. DEMO seeded on Sunset
  Palms ("Park Water — Master C (demo)" serves RV 01-04; RV 01/02 submetered).

### 7. CORS bug fix (apps/api/src/index.ts)
Local dev 30xx ports were dropped in prod-mode (env vars override the localhost
fallbacks) AND a disallowed origin THREW → 500 on the preflight (looked like a
server fault; blocked the dev preview login). Fixed: allowlist localhost 3001-3015
unconditionally (safe — can't be forged remotely) + reject cleanly (`cb(null,false)`).
Prod domains were always allowlisted → real login never affected.

## DECISIONS (Nic-locked this session)
- Deposit multiplier + default term live on the TEMPLATE (per unit type); property
  carries a DEFAULT for occupancy only (seeds units, unit authoritative).
- Late-fee billing = signed-lease stamp, period. Policy changes reach leases only at
  signing/renewal. Late-fee box locked at signing (anti-discrimination).
- Onboarding: co-tenants roster per unit; draft fires when the roster's accepted
  (auto, no explicit close); repair = void unsigned draft + re-draft; supersede once
  a tenant signs.
- RUBS: simple headcount at billing (no time-weighting); only long-term LEASES count
  (weekly = bookings, auto-excluded); submeter exclusion is UNIT-DRIVEN.

## DEFERRED / NEXT (see [[gam-s558-handoff-todo]])
1. **BLIND double-check for front-desk staff** — the verification walk must NOT show
   the previous read to STAFF (bias prevention; standing rule [[gam-blind-staff-entry]]).
   Landlord keeps prior-read view. Gate `priorReadingValue` display by role in the
   reading-run double-check walk.
2. **Landlord utilities UI polish** — Nic: functionality OK, UI needs a pass; specifics
   coming from Nic.
3. **Manual-payment fee first-month waiver** ([[gam-manual-payment-fee-first-month-waiver]])
   — $10 cash/check/MO fee WAIVED on a tenant's FIRST rent payment; portal discloses
   future charges. NOTE: current rule is electronic-only — this ADDS a manual-payment
   path (product change to reconcile). Captured, not built.
4. **Stripe Connect** — still LAST per Nic (re-anchor Stage 2 → N chain).
5. Prospect/Checkr front gate on Flow B; renewal intent front-end + fee planes
   (S556 leftovers); agent-tool multi-lease sweep.
6. Background task RUNNING (separate session): self-host pdf.js in ESignPage (drop CDN).

## Ops / accounts
- Demo password reset this session: **james@demo.dev = landlord1234** (3 properties:
  Copper Canyon, Oak Street Apartments, Sunset Palms RV Resort). Keep
  realestaterhoades EMPTY (agent evals depend on it).
- Master-C demo config seeded on Sunset Palms (delete the empty "back" master Nic
  left from testing if desired).

## Test status
All touched suites green (spot-run per-suite): esign 106, properties 35, units 20,
leases 63, leaseLifecycle 23, landlords-tenant-onboarding 13, leaseOnboardingPipeline
6, s537-late-fee-consistency 20, utilityBilling 28, utilityReadingRuns 27, utility 35.
Both landlord + api typecheck clean. 10 migrations applied 2026-07-26 (all live).
