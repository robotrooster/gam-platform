# Session 177 — closed

## Theme

Two things this session: ship the punch-list-resubmit limbo
dispatch fix (small UX fix per Nic's product walkthrough), and
land the standing-rule update + DEFERRED reclassification from
the broader S176/S177 product Q&A walkthrough that locked
all pre-launch decisions.

## What S177 shipped

### Fix — punch-list-resubmit auto-dispatch to limbo

In `apps/landlord/src/pages/TenantOnboardingPage.tsx`,
`UnitCard.handleSubmit` now re-classifies `groupRows` at submit
time and dispatches accordingly:

- **Rows with remaining identity blockers** (bad email, name, phone) →
  refuse submit; surface a specific "These tenants still need
  fixes: [names]. Resolve the highlighted identity fields, then
  submit." error. No POST fires.
- **Group has lease blockers but all identity is clean** → POST to
  `/landlords/me/onboard-tenants-csv/commit-pending` (limbo).
  Each row becomes `user + tenant + pending_tenant_intent`; lease
  is built later from a parsed PDF.
- **Group is fully clean** → POST to `/landlords/me/onboard-tenants-csv/commit`
  (existing fast-path).

Pre-S177 `handleSubmit` always hit `/commit`, which rejects on
any remaining lease blocker — so a row with an identity-blocker
fix that still has a lease blocker would bounce with a generic
"Submission failed. Check the highlighted fields." error and the
landlord had to hand-route the tenant through the limbo flow.

### UX — differentiated success copy

`UnitCard` tracks `routedTo: 'commit' | 'limbo' | null`. Green
confirmation card differentiates:

- `'commit'` → "Onboarded {propertyName} — Unit {unitNumber}."
- `'limbo'` → "Routed to pending pool — {propertyName} Unit {unitNumber}.
  Upload the lease PDF on the Pending Tenants page to finish
  onboarding."

### Files touched (S177 fix)

```
apps/landlord/src/pages/TenantOnboardingPage.tsx                        (+ identity-vs-lease blocker classification in handleSubmit; + routedTo state; + differentiated success copy)
```

### Verification

- `cd apps/landlord && npx tsc --noEmit` exit 0
- Backend `/commit-pending` endpoint already exists at
  `routes/landlords.ts:866` (per-row tx, server-side identity
  re-validation) — no backend changes needed.
- IDENTITY_FIELDS set already exported from this file (line 164)
  — same constant the initial `splitDirtyRows` uses.

---

## Standing-rule update — CLAUDE.md amended

Per Nic A3 walkthrough confirmation. The "No state-specific
legal logic" rule now has a hard-compliance carve-out:

- **Hard regulatory accommodation** (deposit interest rates, state
  tax form catalog, statutory disclosures) → platform-hardcoded
  with annual-refresh migration cadence
- **Soft legal advice / consumer-facing positioning** (notice
  periods, lease language, fee amounts, recommendations) → still
  landlord-configurable; GAM stays neutral

Framing test added to the rule for future-Claude:
- "Is this a recommendation or piece of advice GAM is making?" → landlord-configurable
- "Is this a statute the landlord has to comply with where the
  platform must accommodate to enable compliance?" → hardcoded
  per state

CLAUDE.md `### No state-specific legal logic` section rewritten
in place.

---

## DEFERRED reclassification

Nic's walkthrough confirmed everything on the list is pre-launch
unless explicitly carved out. Updated DEFERRED.md:

### Tombstoned (kept as record):
- ~~In-house background-check~~ — STRUCK. Checkr-only.
- ~~Cross-platform audit trail validation~~ — STRUCK. One-line
  carryover from S29c-2-F with no remembered intent.
- ~~Guarantor/cosigner billing flow~~ — STRUCK. "If a tenant
  can't pay rent, they don't move in. Rental ≠ car loan."
- ~~Punch-list-resubmit limbo dispatch~~ — SHIPPED S177.

### Annotated with S177 product decisions (now clear scope):
- Short-term booking acks → per-property toggle, e-sign required
  when on
- Property late-fee edit → triggers per-lease addendums + 30-day notice
- Lease-change addendum workflow → addendums for non-material
  changes only; rent/roommate/term changes need new lease
- Deposit interest accrual → state-hardcoded per A3 carve-out
- `lease_fees.due_timing='move_out'/'other'` → ALL outstanding
  tenant balance items (move_out fees, other fees, unpaid rent,
  unpaid utilities) sweep into deposit deduction at move-out
- Stage-2 / Post-capital section renamed to "Pre-launch with
  carve-outs" since "everything on the list is pre-launch" was
  Nic's standing direction

### Scope no-changes:
- Sublease subsystem — pre-launch, build when it surfaces in queue
- POS multi-terminal sync + Stripe Terminal hardware + EOD
  reconciliation — pre-launch
- CSV import mappings for 8 competitors — pre-launch, build all
- Tenant-pool refinements — TBD, defer until Nic walks through it
- 4 npm audit upgrades — all pre-launch, dedicated sessions

---

## Files touched (S177 total)

```
apps/landlord/src/pages/TenantOnboardingPage.tsx                        (handleSubmit limbo dispatch + routedTo state + success copy)
CLAUDE.md                                                               (No state-specific legal logic rule — hard-compliance carve-out added)
DEFERRED.md                                                             (Stage-2 → Pre-launch reclassification; tombstones; per-item S177 annotations)
```

## Decisions made (S177 — captured from product walkthrough)

| Item | Decision |
|---|---|
| A1 — `lease_fees.due_timing='move_out'` | All outstanding tenant balance items sweep into deposit deduction at move-out (move_out fees, other fees, unpaid rent, unpaid utilities). depositReturn service extension. |
| A2 — `lease_fees.due_timing='other'` | Landlord-triggered admin button on lease detail. Platform provides capability, not execution. |
| A3 — Deposit interest accrual | State-hardcoded per state, annual-refresh migration cadence. CARVE-OUT from the "no state-specific legal logic" rule for hard regulatory accommodation. |
| A4 — Cosigner | SCRAPPED. No cosigner schema, no cosigner code. If a tenant can't pay, they don't move in. |
| B1 — Lease-change addendums | Addendums for non-material changes (new house rules, fee config). Material changes (rent, roommates, term) require a new lease + new signatures. |
| B2 — Late-fee edit notice flow | Confirmation modal triggers per-lease addendum generation + 30-day landlord-configurable notice period before changes apply on existing leases. New leases get the new config immediately. |
| B3 — Booking acknowledgments | Per-property `requires_booking_acknowledgment` toggle. When on, every booking (any duration) requires e-sign of property rules before booking confirms. |
| B4 — Punch-list resubmit | SHIPPED S177 (above). |
| C1 — State tax form catalog | All 50 states. Per-property (LLCs are state-filed). GAM surfaces deadlines + form names; does NOT file forms on anyone's behalf. Annual-refresh migration when states change rates / due dates. |
| D1 — Utility billing | Utilities are line items on the rent invoice, NOT separate bills. Per-cycle one combined Stripe charge. Late-cycle utility readings roll into the next cycle's invoice. (REFACTOR — this is the original spec from S90; S122 implemented an alternate Option B that drifted; S177 corrects.) |
| D2 — Flex / OTP UI | Build out fully (Flex tenant-side: FlexPay/FlexCharge/FlexDeposit/FlexCredit; OTP landlord-side). Hide behind a launch flag for v1. |
| E1 — Stripe Connect controller | Stay on Express through launch. |
| E2 — npm audit upgrades | All 4 pre-launch (esbuild→vite 5→8, pdfjs-dist 3→5, tar transitive, uuid→node-cron 3→4). 4 dedicated sessions. |
| F1 — Marketing site | Complete overhaul pre-launch. Pricing currently incorrect (was sample data from a much earlier session). Awaiting Nic's positioning paragraph + target customer. |

## Carry-forward — what S178 should target

The decisions above unlock a substantial pre-launch build queue.
Recommend tackling **D1 (utility line items)** next — it's the
biggest architectural correction, ripples through invoice
generation, payment flow, webhooks, and frontend. Doing it early
clears blockers for the other tenant-facing payment work.

After that, in roughly order of impact:

- A1+A2: depositReturn extension + admin "Bill X fee" button
- A3: deposit interest state-hardcoded module + per-state seed
  data + monthly accrual job
- A4: confirm no cosigner schema/code exists (S177 grep returned
  zero hits — likely already a no-op)
- B1+B2 coupled: material-change new-lease workflow + late-fee
  edit confirm modal + addendum generator
- B3: per-property booking acknowledgment toggle
- C1: 50-state property-state form catalog (~2 sessions: schema +
  seed data + UI)
- D2: Flex tenant suite + OTP landlord-side + launch-hide flag
- Sublease subsystem
- POS multi-terminal sync + Stripe Terminal + EOD
- CSV imports for 8 competitors (parallelizable, ~4-6 sessions)
- E2: 4 npm upgrades (separate sessions)
- F1: Marketing rebuild (after Nic's paragraph)

Plus a tail of smaller cleanup items already in DEFERRED's
Smaller-tracked-items section.

---

End of S177 handoff.
