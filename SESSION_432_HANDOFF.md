# Session 432 — closed

## Theme

**Ninth services-audit session. Single-service slice:
`utilityBilling.ts`. 22 tests pinning the meter-driven
bill-generation engine — submeter usage math, all 4
RUBS allocation methods, idempotency, tenant-
responsibility gate.**

Suite at S431 close: **2224 / 129 files**.
Suite at S432 close: **2248 / 130 files** (+24 cases,
+1 file). 0 failures. Runtime **63.18s**.
Thirty-sixth consecutive fully-green full-suite run.

Zero tsc regressions.

## What shipped

### `services/utilityBilling.test.ts` — 22 cases

`generateBillsForMeter(meterId, cycleMonth)` is the
S90 engine. Three branches, multiple per-unit gates,
idempotent via `utility_bills_one_per_meter_unit_cycle`
UNIQUE.

**Error paths (2)**
- Meter not found → 404
- Property not found for meter (orphaned via FK
  bypass) → 404

**master_bill_to_landlord (1)**
- Returns noop with reason; no rows inserted

**Unit / reading gates (2)**
- No `utility_meter_units` row → "not assigned to
  any units"
- No reading for the cycle → unitsSkipped equals
  units.length

**Submeter (7)**
- First cycle, no prior reading → no bill (baseline)
- Negative usage (meter rollback) → noop with reason
- Happy: charge = usage × rate + base_fee
  (100 × 0.05 + 5 = 10)
- `tenant_responsible=FALSE` → unit skipped
- No active primary tenant → unit skipped (landlord
  absorbs)
- Idempotency: re-running same cycle creates 0 bills,
  UNIQUE catches silently
- isoMonthStart: mid-month input Date maps to month's
  1st in result.cycleMonth

**RUBS (6)**
- equal_split: 3 units × $40 each from $120 total
  (rate 1, base 30, reading 90 → $120/3)
- sqft: 500/1500 split → $50 / $150 from $200 total
- bedrooms: 1/3 split → $25 / $75 from $100 total
- occupant_count: 1 primary vs 1 primary + 1 co-tenant
  → $30 / $60 from $90 total
- Total basis = 0 (sqft method, all NULL) → noop
  with reason
- Zero-basis unit skipped; non-zero units still billed

**generateBillsForProperty (2)**
- Invokes engine for every meter on the property
- Property with no meters → empty array

**generateBillsForLandlord (2)**
- Invokes engine across all properties owned by the
  landlord
- Unknown landlord id → empty array (no meters joined)

## Items shipped

```
apps/api/src/services/
  utilityBilling.test.ts                (NEW — 22 cases)
```

No source code changes. Service preserved as-is.

## Decisions made during build

| Question | Decision |
|---|---|
| Use `new Date('2026-05-01T00:00:00Z')` or `new Date(2026, 4, 1)`? | **Local-time constructor (4, 1)**. The service's `isoMonthStart` helper uses local-time `getMonth()` / `getFullYear()`. In PT (UTC-7), a UTC midnight Date evaluates to the prior day locally → wrong month. The local-time constructor avoids the timezone hop. Caught on first run; 21 failures collapsed to 0 after a single replace_all. |
| Test the orphaned-meter "Property not found" path? | **Yes — but with `session_replication_role='replica'` FK bypass.** The FK normally prevents orphans, but the source has the guard, and the guard is the load-bearing 404. Pinning it explicitly proves the code path is reachable. |
| Pin every RUBS allocation_method individually? | **Yes.** Each method is its own basis-computation path (occupant_count even hits a subquery against `v_lease_active_tenants`). A regression that breaks one method's basis computation wouldn't surface in a single combined test. |
| Pin the idempotency contract? | **Yes — critical.** The S90 engine is intended to be re-runnable; re-running a cycle must not duplicate-bill the tenant. The UNIQUE catch is what makes the engine safe to invoke from a cron retry. |
| Pin the tenant_responsible gate? | **Yes.** It's the single switch landlords toggle to assume a utility themselves. A regression that ignored it would silently bill tenants for utilities the landlord owes. |
| Pin the no-active-primary-tenant case? | **Yes.** Vacant units shouldn't generate tenant bills — landlord absorbs naturally. Skipping is the correct behavior; pinning it prevents a future regression from creating orphan bills. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **2248 tests across 130
  files, 0 failures**, 63.18s. **Thirty-sixth
  consecutive fully-green full-suite run.**
- 22 new test cases.
- 0 production regressions.
- 0 new findings — service matches contract.

## Services audit — progress

Post-S432:

### Direct coverage (41 of 43 services ≈ 95%)

S424: + supersedence
S425: + flexCharge (CRUD half)
S426: + riskScore
S427: + otp (non-Stripe half)
S428: + pdfStamp + pm + landlordPassthrough
S429: + creditScore + creditStats (pure-function half)
S430: + addendumActor + addendumPdf
S431: + flexpay (non-Stripe half)
S432: + utilityBilling

### Still UNCOVERED (~16 files)

Highest-value candidates next:
1. **`subleaseAllocation.ts`** (medium, single)
2. **`stripeConnect.ts`** (huge, multi-session)
3. **pm.ts invitation lifecycle** (continuation of S428)
4. **flexCharge.ts billing/reconciliation half**
   (continuation of S425)
5. **otp.ts Stripe state-machine half**
   (continuation of S427)
6. **flexpay.ts Stripe state-machine half**
   (continuation of S431)
7. **DB-backed credit-ledger wrappers**
   (continuation of S429)
8. Plus ~9 smaller helpers

## Items deferred — what S433 could target

### Continue services audit

**Recommend S433 = `subleaseAllocation.ts`** —
medium-sized single service. Sublease split math is
the next discrete unit; clean target.

**Alternatives:**
- pm.ts invitation lifecycle (continuation of S428)
- flexCharge.ts billing/reconciliation half
- DB-backed credit-ledger wrappers (continuation of S429)
- Start chipping into stripeConnect.ts (multi-session)

### Validation-hygiene backlog (16 items)

Unchanged from S427.

### Cumulative bug-sweep totals (post-S432)

- **47 production bug fixes** (S432 is direct
  coverage of a well-built service)
- 16 architectural / validation findings remaining
- 2248 tests across 130 files
- Suite baseline: **60-63s on a clean machine**

## What S433 should target

**Recommended: `subleaseAllocation.ts`** — medium
single service. Clean target after the
utilityBilling slice.

**Alternatives:**
- pm.ts invitation lifecycle
- flexCharge billing/reconciliation half
- stripeConnect.ts (multi-session arc)

---

End of S432 handoff. **Utility billing slice
shipped — 22 tests pinning the meter-driven
bill-generation engine across submeter usage math,
all 4 RUBS allocation methods, idempotency, and
the tenant-responsibility gate.**

2248 tests / 130 files / 0 failures. Thirty-sixth
consecutive fully-green full-suite run.

**47 cumulative production bug fixes shipped across the
bug sweep.** Services audit: 41/43 covered (≈95%);
16 files remain (smaller helpers + Stripe state-machine
halves + multi-session heavies).
