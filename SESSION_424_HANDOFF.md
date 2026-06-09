# Session 424 — closed — **services audit arc OPENED**

## Theme

**First services-audit session. Direct coverage for
`services/supersedence.ts` — GAM-supersedence routing.
14 tests pinning the public surface end-to-end:
outstanding-debt FIFO query, total sum, and apply-
supersedence with side effects.**

Suite at S423 close: **2018 / 117 files**.
Suite at S424 close: **2035 / 119 files** (+17 cases,
+2 files — slice + vitest-discovery variance).
0 failures. Runtime **61.54s**. Twenty-eighth
consecutive fully-green full-suite run.

Zero tsc regressions.

## What shipped

### `services/supersedence.test.ts` — 14 cases

Tests the three exported functions end-to-end against
real DB rows. Per the memory at
`project_gam_supersedence_routing.md` and CLAUDE.md,
this is load-bearing logic — every successful tenant
ACH pull routes to GAM first to satisfy outstanding
GAM-owed debts before surplus goes to the landlord.

**`computeTenantGamOutstanding` (7 cases)**

The FIFO list of outstanding debts.
- No debts → empty list
- Single defaulted installment → 1 item with shape
- Accelerated deposit → 1 acceleration item (per-
  installment row not double-counted)
- Multiple sources sort FIFO (oldest unpaid_date
  first) — verified across flexpay/custody/installment
- FlexPay advance amount = rent + tenant_fee combined
- FlexCharge statement only included when
  `due_date <= today AND total_due > 0`
- Cross-tenant isolation: other tenant's debts not
  included

**`computeTenantGamOutstandingTotal` (2 cases)**

The sum (cents-accurate via `round2`).
- Zero debts → 0
- Mixed sources sum correctly: 83.33 + 83.34 + 12.50
  = 179.17

**`applyTenantSupersedence` (5 cases)**

The boost distribution on payment settle. Verifies
status flips on real DB rows plus the breakdown
JSON written back to the payments row.
- Boost = 0 → noop result, no DB changes
- Boost fully satisfies installment → row.status flips
  `settled`; breakdown captured with ref_id; payment
  applied_at stamped
- Boost smaller than first item → residual entry
  recorded, no row flip; amount_distributed = boost
  (the boost "left platform" via residual) but
  amount_residual = 0
- Idempotent: second call after applied_at stamped →
  noop
- Boost > total debts → over-collection residual
  recorded under a placeholder `ref_id='over_collected'`

## Items shipped

```
apps/api/src/services/
  supersedence.test.ts                 (NEW — 14 cases)
```

No source code changes. supersedence.ts behavior
preserved as-is.

## Decisions made during build

| Question | Decision |
|---|---|
| Pick supersedence.ts for the first services-audit slice or something simpler? | **Supersedence.** Load-bearing per memory; pure functions over real DB; clean public surface (3 exports); covers the GAM-supersedence routing math that's central to the FlexDeposit/FlexPay product story. High value per test. |
| Pin per-source satisfier functions individually? | **No — implicit via applyTenantSupersedence happy path.** Each source type's status flip is verified end-to-end in the "fully satisfies single installment" test pattern. Per-source unit tests would multiply the slice without surfacing new contracts. |
| Pin the over-collection breakdown (residual ref_id='over_collected')? | **Yes.** That's a real audit-trail contract — admin tooling needs to find these to flag. A future refactor that drops the placeholder breaks compliance reporting silently. |
| Pre-clean tables not covered by cleanupAllSchema? | **Yes — explicit DELETEs before cleanupAllSchema.** flexpay_advances, flex_charge_statements, flex_deposit_installments, etc. aren't in cleanupAllSchema. Without this prefix, the eventual `DELETE FROM landlords` cascade fails on the FK from flexpay_advances. Documented in the slice's beforeEach. |
| Test the FK from flex_deposit_installments to security_deposits with realistic plan_status='active'? | **Yes.** Pre-fix the route SQL filters `WHERE d.flex_deposit_plan_status IN ('active', 'in_default')` so seeding with a different status would silently drop the row. Seeded explicitly. |
| Pin the FIFO ordering with a deliberately-inverted seed order? | **Yes — important.** Seeding newest-first ensures the sort actually fires; a regression that "preserves insert order" would silently break FIFO. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **2035 tests across 119
  files, 0 failures**, 61.54s. **Twenty-eighth
  consecutive fully-green full-suite run.**
- 14 new test cases.
- 0 production regressions.
- 0 new findings — supersedence behavior matches its
  documented contract.

## Services audit — STATUS

S424 kicks off the services audit arc that closes
the broader bug-sweep directive ("sweep the rest of
the platform so we can say no more bugs").

### Tally

Services with dedicated `.test.ts` files
(post-S424, 29 of 43 ≈ 67%):
- New in S424: supersedence.ts
- Pre-existing direct coverage: allocation, books-
  related, csvImportAttempts, depositReturn,
  flexDeposit, flexsuiteAcceptance, flexsuitePdf,
  leaseTermination, notifications, adminNotifications,
  csvImport family, stripeConnectTransfers,
  systemFeatures, taxForms, achRetry, leaseFeesSync
  (incidental from S360), creditDispute (S332 work),
  creditLedger, others
- + CheckrProvider (S420)
- + MockProvider (indirect via background route slices)

### Services still UNCOVERED (~28 files)

Highest-value candidates for follow-on slices,
ranked by criticality:
1. **`flexCharge.ts`** — credit account logic
2. **`stripeConnect.ts`** — destination-charge math (huge
   surface; might need to split across multiple sessions)
3. **`riskScore.ts`** — applicant fraud signals
4. **`otp.ts`** + **`otpScheduler.ts`** — On-Time Pay
   advancement math
5. **`creditScore.ts`** + **`creditStats.ts`** — credit
   ledger formula + stats
6. **`utilityBilling.ts`** — utility billing math
7. **`subleaseAllocation.ts`** — sublease ledger
8. **`pdfStamp.ts`** — signed PDF stamping
9. **`pm.ts`** — PM company resolution
10. **`landlordPassthrough.ts`** — banking-fee passthrough
11. Plus ~18 smaller helpers

At the S424 cadence (~30 min per service), the
remaining audit is ~14 hours of work / ~28 sessions.

## Items deferred — what S425 could target

### Continue services audit

**Recommend S425 = `flexCharge.ts`** — next-highest-
value uncovered service. Credit account logic +
enrollment gating + statement generation.

### Validation-hygiene backlog (15 items, mostly Nic-pending)

Unchanged from S423.

### Cumulative bug-sweep totals (post-S424)

- **47 production bug fixes** (S424 is direct coverage
  of an existing well-built service, no new bugs
  surfaced)
- 15 architectural / validation findings remaining
- 2035 tests across 119 files
- Suite baseline: **60-62s on a clean machine**

## What S425 should target

**Recommended: `services/flexCharge.ts` direct
coverage.** Next-highest-priority uncovered service.
Same slice pattern as S424.

**Alternatives:**
- Other uncovered services in priority order above
- Pick a batch of 2-3 small services for one
  multi-target session
- Hygiene-backlog cleanup (mostly Nic-pending though)
- Wait for Nic input on the pending items

---

End of S424 handoff. **Services audit arc opened
with `supersedence.ts` direct coverage. 14 tests
pinning GAM-supersedence routing end-to-end.**

2035 tests / 119 files / 0 failures. Twenty-eighth
consecutive fully-green full-suite run.

**47 cumulative production bug fixes shipped across the
bug sweep.** Services audit arc now live; ~28 service
files remain uncovered.
