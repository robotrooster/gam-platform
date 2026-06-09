Session 29c-2-F Handoff — ConfirmIntentModal editable entity arrays

Date written: April 29, 2026
Branch: main (uncommitted — Nic handles git locally)
TSC: apps/landlord plain clean. apps/landlord strict (--noUnusedLocals) clean for ConfirmIntentModal.tsx and ConfirmIntentModal.entities.tsx. ~20 pre-existing strict-mode hits remain in other landlord files (not touched this session).
Runtime: not booted in production this session. Visual smoke deferred — see below.

SESSION PURPOSE

Single deliverable: ConfirmIntentModal's read-only "Other items extracted" pill row replaced with full editable sections for vehicles, RVs, pets, additional occupants, tenant IDs, emergency contacts, liability insurance, and mobile home. Was Priority 1 in S29c-2-E's queued work. Backend was schema-validated in S29c-2-E so this UI was unblocked.

KEY DESIGN INSIGHT — wholesale-section overrides

The mergeParserOutput function in apps/api/src/jobs/leaseParser/resolveIntent.ts uses a plain spread for entity fields:

  return { ...baseSafe, ...overrides, tenants: mergeTenants(...), unit: {...}, lease: {...} }

Only tenants/unit/lease get explicit merge logic. Vehicles, rvs, pets, additionalOccupants, liabilityInsurance, mobileHome are wholesale-replaced when present in overrides. Per-leaf dot-paths like "vehicles.0.year" would build {vehicles: [{year}]}, the spread would clobber the parser's full vehicles array, and the resolveIntent writer would crash on v.vehicleType.value (NOT NULL column read off undefined).

So the only safe approach is: when the landlord touches anything in a section, send the entire materialized array. Untouched sections are omitted from overrides, parser_output flows through unchanged. Tenant-nested arrays (identifications, emergencyContacts) ride mergeTenants and get sent inside tenants[0].

This is now a load-bearing assumption documented in ConfirmIntentModal.entities.tsx's header comment. If anyone changes mergeParserOutput later, the comment must be updated and the override-shaping logic in handleSubmit revisited.

WHAT SHIPPED

New file: apps/landlord/src/pages/ConfirmIntentModal.entities.tsx (522 lines)

Exports:
- EntityArraySectionId, EntityObjectSectionId, EntitySectionId types
- SECTION_META — title, rowLabel, fields config per section
- asOverrideField(value) — wraps a raw value into ParserExtractedField shape with confidence 1.0 + rawText sentinel "(landlord override)"
- freshRow(sectionId) — creates a new row with required-select fields defaulted to first option (so writer doesn't crash on add-row-then-build before edit)
- EntityFieldRow — reduced FieldRow scoped to a row's leaf field. No dot-path indirection. Detects landlord-override mode by the rawText sentinel. No revert button (user removes the row instead).
- EntityArraySection — collapsible card per array. Header shows count + edited badge. Body lists rows with per-row Remove + Add button.
- EntityObjectSection — single-object variant for liabilityInsurance and mobileHome.
- UndoToast — 5-second undo window, positioned at modal scope.

Field configs mirror the DB schema:
- VEHICLE_FIELDS: vehicleType (required, select VEHICLE_TYPES), year, make, model, color, licensePlate, plateState
- RV_FIELDS: year, make, model, vin, lengthFt, numSlides, hookupClass (select RV_HOOKUP_CLASSES), licensePlate, plateState
- PET_FIELDS: species (required, select PET_SPECIES), name, breed, color, ageYears, weightLbs, isServiceAnimal, isEmotionalSupport
- OCCUPANT_FIELDS: fullName (required), relationshipToPrimaryTenant, dateOfBirth, isMinor
- ID_FIELDS: idType (required, select ID_TYPES), idNumber (required), issuingState, issuingCountry, expiryDate
- EMERGENCY_FIELDS: name (required), phone, email, relationship
- INSURANCE_FIELDS: carrierName, policyNumber, expiryDate
- MOBILE_HOME_FIELDS: year, make, model, serialNumber, hudLabelNumber, lengthFt, widthFt, manufacturedDate

Required-field marks mirror DB NOT NULL columns: lease_vehicles.vehicle_type, lease_pets.species, lease_occupants.full_name, tenant_identifications.id_type+id_number, emergency_contacts.name.

Modal patches: apps/landlord/src/pages/ConfirmIntentModal.tsx (729 → 1001 → 951 lines after dead-code removal)

Nine patches applied via Python script with anchor pre-flight verification. Failures abort before any write — no partial-apply risk:

1. Imports — added all entity-module exports
2. State hooks — entityArrays (Record<EntityArraySectionId, any[]>), entityObjects (Record<EntityObjectSectionId, any|null>), touched (Set<EntitySectionId>), collapsed (Set<EntitySectionId>), pendingRemoval (undo buffer), removalTimerRef, entitiesInitialized ref
3. Init effect + handlers — useEffect seeds working state once parser_output arrives. Initial collapse: empty sections collapsed, populated expanded. Handlers: markTouched, updateEntityRow, addEntityRow (auto-expands the section), removeEntityRow (sets 5s timer), undoEntityRemoval, dismissRemoval, updateEntityObject, toggleCollapsed
4. missingRequired extension — iterates entityArrays, checks required leaves per SECTION_META.fields, pushes paths like "vehicles.0.vehicleType" or "pets.1.species" to missingRequired. Footer error surfaces them.
5. handleSubmit body shaping — after materializeOverrides, layers in touched sections: vehicles/rvs/pets/additionalOccupants/liabilityInsurance/mobileHome go on the top-level override object; identifications/emergencyContacts go inside materialized.tenants[0]. Untouched sections omitted.
6. Drop EntitySummary call from JSX
7. Insert IDs + emergency sections in JSX (after mailing address, before Property and unit)
8. Replace mobileHome FieldRow conditional with five EntityArraySection / EntityObjectSection mounts: occupants + pets under "Co-residents", vehicles + rvs under "Vehicles and RVs", liabilityInsurance + mobileHome under "Insurance and dwelling"
9. Render UndoToast at modal scope (sibling of footer, inside modal container)

Cleanup patch: dropped dead EntitySummary function (50 lines, 1904 chars). Now references zero unused locals in ConfirmIntentModal.tsx — confirmed via tsc --noEmit --noUnusedLocals.

DEFERRED — UI/UX BATCHED AT BACKEND-COMPLETE

Per standing policy: all UI/UX checks (smoke, polish, render eyeballing) batch into a single list Nic compiles when backend is complete. Not session-blocking. Not a recommended next step. The items below are raw material for that future list, not a pre-push checklist.

(a) Section order: Tenant identity → Tenant IDs → Emergency contacts → Property and unit → Lease → Co-residents → Vehicles and RVs → Insurance and dwelling
(b) Empty sections collapsed (▸ arrow + "0 vehicles"), populated sections expanded (▾ arrow + count)
(c) Add row — click "+ Add vehicle", new row with vehicleType defaulted to "car", section header gets "edited" badge
(d) Remove + undo — click Remove, dark toast at bottom-of-modal with "Undo". Click within 5s, row returns at same index. Second removal cancels the previous undo timer.
(e) Required-leaf guard — add an ID, leave idNumber blank. Footer shows "Missing required: idNumber" and Build button disables.
(f) Edit existing parsed row — change a year from parsed value, "edited" badge appears on the leaf, section header gets "edited" badge.

If any break, expect either a CSS conflict from the modal-overlay z-index (UndoToast is absolutely positioned), or a section-meta typo. Both are <30-line patches.

DEFERRED THIS SESSION — Priority 2 from S29c-2-E

End-to-end smoke: PDF upload → parser → confirm modal → /resolve → lease in DB → activation email. Backend is tsc-clean and schema-validated as of S29c-2-E. UI is now feature-complete as of this session. Smoke is the natural next step. Watch points (carried forward from S29c-2-E):

(a) JSONB serialization round-trip on parser_output and parser_flags
(b) PDF promotion (rename pending → leases dir)
(c) emailTenantOnboarded signature match — failure is logged-not-fatal so could be silent
(d) Activation URL formatting matches what the activation page expects
(e) NEW: with entity arrays now sendable, watch for shape errors at resolveIntent's writers — the writers were validated against parser-shaped data in S29c-2-E's diff harness, but landlord-override-shaped rows (newly added rows that never went through parser) are a fresh code path

Recommendation: dedicated smoke session. Don't fold into S29c-2-G or anything else.

CARRY-FORWARD DEFERRED LIST

Removed (verified done this session):
- ConfirmIntentModal editable entity arrays (Priority 1 from S29c-2-E)

Active (unchanged from S29c-2-E):
- Sublease subsystem full build
- Cross-platform audit trail validation
- Tenant-pool endpoint
- Platform-specific CSV import mappings (Buildium, AppFolio, DoorLoop, Yardi, RentManager, Propertyware, Rentec Direct, TenantCloud + 1-2 TBD)
- tenants.background_check_status / background_check_id columns missing
- 5 of 8 npm audit vulnerabilities (nodemailer pending email consolidation; uuid via node-cron + svix + resend pending major-version session)
- Tenant-pool picker + unit picker with consent rule
- Extract void cascade switch into shared helper
- Wrap POST /sign/:documentId in transaction
- POST /esign/documents should also reject executionFailed docs
- Notifications schema rebuild
- Witness in send modal
- Tenant draft persistence
- Tenant decline path with reason + landlord notification
- Tenant view-only re-open of executed/in-flight docs
- Movie-font signature styles to professional fonts
- Two parallel email systems consolidation (services/email.ts Resend vs lib/email.ts nodemailer)
- 3 backup files cleanup (s19backup, s20backup, s21backup in routes/)
- Source PDF path resolution rebuild (currently split('/').pop() — fragile)
- Initials lock-to-name (low priority edge case)
- Properties endpoint $9 placeholder + missing amenities column
- PM subsystem (full build or rip pm.ts)
- GAM Books AZ-specific tax logic genericization
- Master Schedule finish-or-strip
- ReportsPage endpoint build (GET /api/reports/summary)
- Team UI rebuild (single team_member_scopes table)
- S23d Tier 1 CHECK migration: 11 of 14 still pending Session B
- Permission gating audit across landlord portal
- Short-term booking acknowledgment docs on unit_bookings
- Payment-method surcharge passthrough at property level
- Consolidated landlord-side ACH pull optimization
- Guarantor/cosigner billing flow
- Flex Suite reintroduction
- Property late-fee edit confirmation modal with addendum/notice-period reminder
- Lease-change addendum workflow with legal notice timing
- Deposit interest accrual engine
- Landlord disbursement engine that nets tenant-owed deposit interest
- leases.security_deposit cleanup
- S26a catch-up window admin endpoint (POST /admin/invoices/backfill)
- lease_fees.due_timing='move_out' and 'other' not consumed by any generator yet
- Branch hygiene: feature/gam-books deletion/rename
- Email-failure surface to landlord UI
- E-sign /files/:filename auth gap
- pdf.js loader extraction (now duplicated 6 times)
- Optional CSV-typed lease priors
- Punch-list-resubmit limbo dispatch
- 5 broken bookkeeper endpoints in routes/books.ts
- routes/utility.ts dormant + has SQL injection
- Empty stub utility tables in live DB
- schema.sql full regen + migrate.ts rewrite
- Static schema diff harness extraction (apps/api/scripts/diff-schema.ts)
- dev.sh admin-ops duplicate line (one-line cleanup)

New from this session:
- ConfirmIntentModal visual smoke (see Follow-through above)
- End-to-end /resolve smoke including landlord-overridden entity rows (Priority 2 in next session)
- noUnusedLocals strict-mode hygiene pass on landlord. Currently OFF in tsconfig. Forced run shows ~20 unused-imports/locals across Layout.tsx, NotificationBell.tsx, BackgroundChecksPage.tsx, DashboardPage.tsx, DisbursementsPage.tsx, DocumentsPage.tsx, InviteTenantModal.tsx, LeasesPage.tsx, LoginPage.tsx, plus likely more downstream. Either turn the flag on and clean all hits, or scope-lock and skip. Do NOT incrementally fix without dedicated session — historical drift across multiple sessions will fight you.

NEW STANDING RULES FROM THIS SESSION

1. When mergeParserOutput-style merge code uses a plain spread for some fields and explicit merge for others, that distinction is load-bearing. Document the per-field merge behavior at the call site of any UI that produces overrides. Future sessions will get this wrong otherwise.

2. Pre-flight anchor verification before applying patches. The S29c-2-F patch script verified all 9 anchors had exactly 1 match before writing anything. If any anchor returns 0 or 2+ matches, abort. This caught nothing this session but is cheap insurance — partial-apply state is much harder to recover from than a clean abort.

3. Heredoc verification rule from S29c-2-E held this session: every cat-heredoc was followed by ls + wc -l in the same chain. Zero phantom-creation incidents.

4. When a handoff lists pre-existing TSC issues, run the strict tsc against the actual codebase before deciding scope. S29c-2-D's TSC-rot list was already mostly fixed. S29c-2-E's "auth.ts @gam/shared" was the only real remaining item, and it got fixed by the project references migration. Don't trust handoff TSC lists without verification.

End of S29c-2-F handoff.
