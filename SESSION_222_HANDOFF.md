# Session 222 — closed

## Theme

DEFERRED.md hygiene. Recon for the next build target turned up
that 8 items in the "Smaller tracked items" section had shipped
without being struck — the queue had drifted. Per CLAUDE.md
session-close discipline: "Shipped items get deleted from
DEFERRED.md (one-line tombstone for major items, full deletion
for completed sub-items). Audit trail lives in handoffs and
git, not in DEFERRED.md."

## What S222 shipped

### DEFERRED.md trim — "Smaller tracked items" section

Stripped 8 items that had shipped or been struck per prior
sessions:

| Item | Verified shipped where |
|---|---|
| Short-term booking acknowledgment docs on unit_bookings | Schema + API + landlord UI on PropertiesPage / BookingsPage / SchedulePage all live |
| Payment-method surcharge passthrough at property level (S172) | Already noted shipped inline; sub-item per CLAUDE.md → full deletion |
| Consolidated landlord-side ACH pull optimization (S113 superseded) | Stripe Connect destination charges auto-batch — superseded |
| Lease-change addendum workflow with legal notice timing (S202/S213) | `services/addendumPdf.ts` + lease PATCH non-material-changes path + credit-ledger `lease_addendum_recorded` event all live |
| Deposit interest accrual engine | `services/depositInterest.ts` + scheduler wiring + depositReturn integration (`deposit_interest_paid` event) all live |
| `leases.security_deposit` deprecation into lease_fees | Column dropped on disk via `20260508170000_drop_leases_security_deposit.sql` (S195/S196) |
| `lease_fees.due_timing='move_out'` and `'other'` | Per CLAUDE.md S180–S182: all four CHECK values wired to billing paths (move-in invoice / monthly cron / depositReturn auto-sweep / admin-trigger billing route) |
| Punch-list-resubmit limbo dispatch — already marked SHIPPED S177 | Sub-item, no audit value beyond git/handoff |
| Guarantor/cosigner billing flow — already marked STRUCK S177 | Sub-item, no audit value beyond git/handoff |
| ConfirmIntentModal noUnusedLocals strict-mode hygiene pass — SHIPPED S96 | Sub-item, full deletion |
| Tenant TSC strict-mode parity — SHIPPED S97 | Sub-item, full deletion |
| Admin / books / pos / admin-ops / property-intel TSC strict-mode parity — SHIPPED S98 | Sub-item, full deletion |

(That's 12 entries across the 8 conceptual items — the strict-
mode parity work spanned three sub-items in DEFERRED.)

### Items kept (6 active)

- Property late-fee edit confirmation modal (real product fork
  — needs Nic input on whether property-level late fee is a
  template that propagates to existing leases or only seeds
  defaults for new leases)
- Landlord disbursement engine that nets tenant-owed deposit
  interest from monthly payouts (separate from the lease-end
  netting which IS wired)
- End-to-end /resolve smoke including landlord-overridden
  entity rows
- Platform-specific CSV import mappings (8+ vendors)
- Tenant-pool picker + unit picker with consent rule
- 4 of 8 npm audit root-vuln packages (esbuild / pdfjs-dist /
  tar / uuid — all need breaking upgrades, deferred to
  dedicated sessions)

### Files touched (S222)

```
DEFERRED.md  (- 51 lines: 644 → 593)
```

## Decisions made (S222)

| Question | Decision |
|---|---|
| Strip the SHIPPED/STRUCK tombstones from "Smaller tracked items" entirely, or convert to one-liners? | Strip entirely. Per CLAUDE.md: "full deletion for completed sub-items." Tombstones with detailed status notes belong in handoffs + git, not DEFERRED. |
| Apply same trim to the "Build sessions" section (lines 99-526)? | No — out of scope for this cleanup. Many of those numbered items (1-19) have substantial inline status notes spanning 5-30 lines each. Going through 426 lines of build-session detail is its own session. The active-vs-shipped status is at least visible inline; full tombstone-conversion can wait. |
| Apply trim to the "Pre-launch (S177 reclassification)" section? | No — the 4 items there (Flex Suite, OTP, Sublease subsystem, tenant-pool endpoint refinements) are all genuinely live work. The "Struck at S177" subsection explicitly says "kept here as tombstone" — intentional. |
| Verify the "Landlord disbursement engine that nets tenant-owed deposit interest from monthly payouts" status before stripping? | No — kept it. Recon showed lease-end deposit-return netting IS wired, but couldn't quickly verify whether monthly-payout netting is wired (would need deeper service trace). Conservative: leave it as active until verified shipped. |
| Update CLAUDE.md S205-era stale figure ("22 forms / 11 states") to reflect current 38/69 from S221? | Already noted in S221 handoff but not in CLAUDE.md itself. Defer — CLAUDE.md edits should bundle multiple drift fixes when they happen, not get one-off touches. |

## Carry-forward — S223+

The DEFERRED.md "Smaller tracked items" section now has only
6 genuinely active items, all of which have either:
- Real product forks (late-fee modal)
- Substantive lifts requiring multi-session work (CSV imports,
  tenant-pool picker, npm upgrade sessions)
- Verification-only scope (smoke, monthly-payout netting check)

Genuinely small, no-fork next sessions are scarce — the POS
sweep (S217-S220) and state tax catalog (S203-S221) closed the
two recent ongoing threads. Next session needs Nic to pick a
direction:

- **Late-fee modal** — needs scope-shaping (template vs default-
  for-new) before code
- **Wire `pos_tax_rates` → cart math** (S217 carry) — needs
  product call on stacking + override semantics
- **Sublease phase 3** — multi-session greenfield build
- **Stripe Connect S113 rebuild** — multi-session
- **Build-sessions DEFERRED tombstone trim** — pure hygiene,
  full session of trimming the 426 lines of Build-sessions
  status notes down to one-line tombstones each. Mechanical
  but tedious.

### Already-known carry-forward (unchanged)

- POS thread polish — `pos_items.category → FK to pos_categories.id`
  refactor + `(landlord_id, name)` UNIQUE on pos_categories
  (S220 carry, low-priority pre-launch)
- A3 polish (mostly diminishing returns)
- Primary manager urgency tier (S185 — needs Nic input)
- Owner-financial-escalation pattern (S186 — needs Nic input)
- B3 hard-gate check-in (product fork)
- D2 Flex tenant suite (launch-flag gated)
- F1 Marketing rebuild
- POS Terminal hardware

---

End of S222 handoff.
