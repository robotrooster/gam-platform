# Session 439 — closed

## Theme

**Sixteenth services-audit session. Second triplet
sweep: `maintenanceRequests.ts` + `taxForms.ts` +
`posTax.ts`. 22 tests pinning the maintenance-request
creation flow (tenant access + attribution + comment
seed + notification), the S203 tax-form catalog
filter chain (federal + state forms by landlord
context), and the S241 POS cart tax math (rate
stacking, category match, property-bound vs
landlord-wide fallback).**

Suite at S438 close: **2382 / 136 files**.
Suite at S439 close: **2405 / 137 files** (+23 cases,
+1 file). 0 failures. Runtime **73.30s**.
Forty-third consecutive fully-green full-suite run.

Zero tsc regressions.

## What shipped

### `services/s439Triplet.test.ts` — 22 cases

Three small services in one file. `routeMaintenanceNotification`
mocked via `vi.hoisted`; `state_tax_forms` rows isolated
via `effective_year=2099` (avoids clashing with the
S203/S204/S205 production catalog seed).

**`maintenanceRequests.ts` — createMaintenanceRequest (7)**
- Unit not found → 404
- Tenant not on the unit's active lease → 403
- Tenant on active lease → request created with
  tenant_id=self; landlord_id stamped from unit row;
  routeMaintenanceNotification fires with request id;
  first comment row inserted with role='tenant' and
  description embedded in the message
- Landlord caller: attribution falls back to
  `v_unit_occupancy.primary_tenant_id`; comment row
  gets role='landlord'
- Landlord caller + no primary tenant (e.g., vacant
  unit with terminated lease) → tenant_id NULL on the
  inserted row
- Notification throw swallowed — request still
  created (best-effort hook per source comment)
- Priority defaults to 'normal'; photos defaults to []

**`taxForms.ts` — getApplicableTaxForms (6)**
- `all_landlords` federal form always included
- `with_employees_in_state` federal form gated by
  active books_employees row (status='active')
- Inactive (terminated) employees do NOT trigger
- `with_contractors_paid_600` gated by
  `ytd_paid >= 600` — boundary test: 599.99 excludes,
  600.00 includes
- `with_property_in_state` form fires only when the
  landlord owns property in that state code (AZ form
  matches AZ property; CA form excluded with no CA
  property)
- Empty year → returns empty array

**`posTax.ts` — calculateCartTax (8)**
- Empty cart → zeros
- Phantom item id (not owned by landlord) → throws
  ("not owned by this landlord")
- `applies_to=['all']` rate stacks on every line
  ($0.17 × 2 lines = $0.34 — pinned line-level
  rounding behavior)
- `applies_to=['Beverages']`: applies to Beverages
  item, NOT Snacks item (category-scoped)
- Case-insensitive category match with whitespace
  padding (`'  BEVERAGES  '` matches `'Beverages'`)
- Multiple rates STACK on the same line (5% + 2% + 1%
  on $100 = $8)
- `is_active=FALSE` rates skipped
- Property-bound rates WIN over landlord-wide for
  that property's items; landlord-wide only applies
  when no property-bound rate exists

## Items shipped

```
apps/api/src/services/
  s439Triplet.test.ts                   (NEW — 22 cases)
```

No source code changes. All three services preserved
as-is.

## Decisions made during build

| Question | Decision |
|---|---|
| Isolate state_tax_forms with `effective_year=2099` or clear the production-seeded rows? | **Isolate at 2099.** S203/S204/S205 seeded the real US + 11-state catalog (~22 forms). Clearing those would mean re-seeding for every test that depends on them; isolating at a far-future year keeps tests deterministic without disturbing the catalog. |
| Pin the contractor `ytd_paid >= 600` boundary exactly? | **Yes — IRS threshold.** $600 is the literal 1099-NEC reporting threshold. A regression that flipped `>=` to `>` would silently miss landlords paying exactly $600 to a contractor. The 599.99 / 600.00 pair test pins both sides. |
| Pin the line-level rounding behavior in posTax? | **Yes — money math.** Two lines at $0.165 each rounds to $0.17 + $0.17 = $0.34, not 0.33 (which would be transaction-level rounding of $0.33). The source comment says transaction-level "to avoid compounding rounding drift," but the implementation actually rounds at line level then sums — caught the discrepancy in the math, confirmed by test failure, kept the test as documentation of the actual behavior. |
| Pin the case-insensitive category match? | **Yes — UX-impacting.** Landlord types "BEVERAGES" in the admin form but the category is "Beverages" — matching needs to tolerate the case difference. A regression that dropped `.toLowerCase()` would silently fail to apply rates the landlord configured. |
| Pin the property-bound override of landlord-wide rates? | **Yes — per-property tax model.** A landlord with state rates landlord-wide and city rates per-property needs the per-property set to WIN (not stack). A regression that stacked both would double-charge tax on items at properties with their own rate set. |
| Cover maintenanceRequests' fallback attribution path? | **Yes — empty-unit edge case.** When a landlord files a maintenance request for a vacant unit, there's no primary tenant — the row should accept tenant_id=NULL gracefully. A regression that crashed on the LEFT JOIN miss would make landlords unable to file requests for vacant units. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **2405 tests across 137
  files, 0 failures**, 73.30s. **Forty-third
  consecutive fully-green full-suite run.**
- 22 new test cases.
- 0 production regressions.
- 1 finding (semi-bug): posTax source comment claims
  transaction-level rounding "to avoid compounding
  rounding drift" but implementation rounds per-line
  then sums per-line. Documented in test; behavior
  matches what the code does. No change recommended
  without confirming intent with Nic (could be either
  the comment or the code that's wrong).

## Services audit — progress

Post-S439:

### Direct coverage — 49 services with .test.ts files

S438: + systemFeatures + leaseFeesSync + connectPayouts.
S439: + maintenanceRequests + taxForms + posTax.

### Still UNCOVERED (~7 files post-S439)

1. **otp.ts Stripe state-machine half** (S427
   continuation)
2. **flexpay.ts Stripe state-machine half** (S431
   continuation)
3. **flexCharge.ts billing/reconciliation half**
   (S425 continuation)
4. **creditLedgerEmitters.ts** (900 lines —
   multi-session)
5. **Remaining smaller helpers**: posTerminal (291),
   depositInterest (352), backgroundProvider (359),
   depositPortability (379), subleaseDocuments (388),
   email (854)

(otpScheduler.ts is DISABLED per file header — skip.)

## Items deferred — what S440 could target

### Continue services audit

**Recommend S440 = another triplet sweep**: `posTerminal.ts`
(291) + `depositInterest.ts` (352) + `depositPortability.ts`
(379). Three medium helpers in one session.

**Alternatives:**
- Three smaller helpers each in their own file
- backgroundProvider + subleaseDocuments + email triplet
- otp.ts Stripe state-machine half (heavy single)
- flexpay.ts Stripe state-machine half (heavy single)
- flexCharge.ts billing half (heavy single)
- Start creditLedgerEmitters.ts multi-session arc

### Validation-hygiene backlog (16 items)

Unchanged from S427.

### Cumulative bug-sweep totals (post-S439)

- **47 production bug fixes** + **1 documented finding**
  (posTax rounding-level discrepancy between source
  comment and implementation — flagged, not changed
  pending Nic call)
- 16 architectural / validation findings remaining
- 2405 tests across 137 files
- Suite baseline: **60-75s on a clean machine**

## What S440 should target

**Recommended: triplet sweep through posTerminal +
depositInterest + depositPortability.** Continues the
long-tail close-out at medium-helper scope.

**Alternatives:**
- Three different helpers (smaller triplet — backgroundProvider
  + subleaseDocuments + email)
- otp.ts Stripe state-machine half
- flexpay.ts Stripe state-machine half
- flexCharge billing half
- Start creditLedgerEmitters.ts multi-session arc

## Findings flagged for Nic review

**posTax line-level rounding (S439 #1):** Source
comment in `posTax.ts:22-24` says "rounded to cents at
the transaction level (not per-line, to avoid
compounding rounding drift on multi-item carts)" but
the implementation does `round2(...)` at every step
of the loop, producing line-level rounding. Test
pinned actual behavior ($0.17 + $0.17 = $0.34). Two
options:
1. Update the comment to match the per-line behavior.
2. Refactor the loop to compute raw line tax in cents,
   sum, round once at end (matches comment intent;
   produces $0.33 in the test case).

Defer to Nic — money math; doesn't want to flip
without product call.

---

End of S439 handoff. **Triplet shipped — 22 tests
pinning maintenance request creation (with tenant
access + attribution + notification), the S203 tax
form catalog filter chain (federal + state by
landlord context, contractor $600 boundary), and
the S241 POS cart tax math (rate stacking, category
match, property-bound override, line-level rounding
behavior).**

2405 tests / 137 files / 0 failures. Forty-third
consecutive fully-green full-suite run.

**47 cumulative production bug fixes** + 1 documented
finding (posTax rounding comment-vs-code mismatch).
Services audit: 49 services covered; 7 files remain
(continuation halves + smaller helpers).
