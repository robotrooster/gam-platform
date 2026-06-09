# Session 449 — closed

## Theme

**First post-services-audit session. Pivoted from the
"validation-hygiene backlog sweep" S448 recommended (most
items are Nic-pending product decisions, not actionable
without input) to ROUTE-level coverage of the three small
uncovered money-flow routes — withdrawals.ts, finances.ts,
disbursements.ts. Real-money paths (Stripe Payouts, Connect
balance, audit history) with ZERO prior test coverage.
31 cases shipped. One test-infra fix caught during authoring
(disbursements cleanup gap — third one of this pattern,
following S445 flexpay_advances and S446 flex_charge).**

Suite at S448 close: **2690 / 145 files**.
Suite at S449 close: **2724 / 146 files** (+34 cases,
+1 file — 31 new cases here plus minor upstream).
0 failures. Runtime **70.01s**. Fifty-second consecutive
fully-green full-suite run.

Zero tsc regressions.

## What shipped

### `routes/moneyTriplet.test.ts` — 31 cases (NEW file)

Pattern from S438 triplet: mock `services/connectPayouts`
exports (getConnectBalance + firePayoutForConnectAccount)
at module level, build supertest app per buildApp() helper,
seed users with parametric Connect-onboarding state, drive
each route's gates + happy + filters.

**withdrawals.ts — GET /me/withdrawals/preview (6)**
- No Stripe Connect account → 409
- connect_payouts_enabled=false → 409 (KYC not complete)
- Happy: $100 std + $50 instant → instant fee = max(50*0.015,
  $0.50) = $0.75; net = $49.25
- Instant fee MIN $0.50 floor: $10 balance → fee=$0.50, not
  $0.15 (0.015×10)
- Zero balance → both channels ineligible
- No auth header → 401

**withdrawals.ts — POST /me/withdrawals (8)**
- No Connect → 409
- KYC incomplete (connect_details_submitted=false) → 409
- Zero available → 400
- Happy standard: payout fires with method='standard',
  audit row in disbursements (trigger_type='manual_on_demand',
  status='processing'), fee_charged=0, net_to_user=amount
- Happy instant: pulls instant_available (not available),
  stamps projected fee onto disbursement row
- Default method (omitted body) → standard
- Invalid method ('overnight') → 400 (zod)
- Idempotency key: per-method prefix; distinct between
  std and instant calls within same second

**finances.ts — GET /me/finances (9)**
- No Connect → current_balance=0, connect_ready=false, no
  Stripe call
- Stripe balance call surfaces available + pending USD
- Stripe call THROWS → endpoint still 200, balances default
  to 0 (does NOT 500 — pinned to keep endpoint responsive
  per route's docstring)
- entries: scoped to req.user.userId only (cross-user
  isolation)
- propertyId filter: owned property → entries narrowed by
  property_id
- propertyId filter: non-owned, non-managed → 403
- propertyId filter: unknown property → 404
- Admin can pull any property without authz check
- limit query coercion: ?limit=5 returns 5 rows
- Back-compat: unrouted_balance=0 + per_bank=[] always
  returned

**disbursements.ts — GET /api/disbursements (8)**
- Non-admin returns only own user_id disbursements
- Admin sees all
- super_admin sees all (same as admin)
- Orders by created_at DESC (forced timestamp gap)
- Joins user shape + LEFT JOIN tolerates null bank_account_id
  (bank_nickname=null + bank_last4=null)
- LIMIT 50 cap (seeded 55 → returned 50)
- No auth → 401

### Test-infra bug — `cleanupAllSchema` missing disbursements

`disbursements` FKs landlords, user_bank_accounts, AND
users. Without a `DELETE FROM disbursements` in
`cleanupAllSchema`, any test that wrote a disbursement
(any POST /me/withdrawals call) trapped the next file's
beforeEach on the landlord/user delete chain. This is the
**third** time this same pattern surfaced during the bug
sweep:

1. S445 — `flexpay_advances` cleanup missing
2. S446 — `flex_charge_*` chain ordering wrong (×2)
3. **S449 — `disbursements` cleanup missing**

`stripeConnectWebhooks.test.ts` had a workaround
pre-cleaning disbursements inline (S418-ish? not dated);
that workaround is now obsolete — the central helper
handles it.

**Fix:** added `DELETE FROM disbursements` to
`apps/api/src/test/dbHelpers.ts` right before the
landlord/tenant/user delete chain, with an S449 comment
referencing the prior two fixes so future readers see the
pattern.

## Items shipped

```
apps/api/src/routes/
  moneyTriplet.test.ts                  (NEW — 31 cases)
apps/api/src/test/
  dbHelpers.ts                          (+6 lines: disbursements cleanup)
```

No production source changes. Routes were correct as-shipped.

## Decisions made during build

| Question | Decision |
|---|---|
| Follow S448's validation-hygiene recommendation literally? | **No — pivot.** Recon showed the backlog is mostly Nic-pending product decisions (LEASE_TYPE_MATRIX↔CHECK drift needs Nic-decided canonical UNIT_TYPES; S408 finding A+B Nic-pending; S412/S416 Nic-pending; S413 needs UX design; S417 PATCH-email routes don't exist yet). Per `feedback_dont_overdefer.md`, NOT every item is Nic-blocked, but the actionable ones are zero-yield without product context. **Pivot to route coverage** where the bug-sweep can still surface real findings. |
| Triplet routes vs single? | **Triplet.** Same shape as S428/S438 triplets — 3 small services in one session caps the per-session yield. withdrawals + finances + disbursements are interlocking (Stripe Connect balance flows through all three), so seeding logic shares cleanly across describe blocks. |
| Mock `connectPayouts` or `lib/stripe` directly? | **Mock `connectPayouts`.** s438Triplet already covers the lib/stripe→connectPayouts internals end-to-end; mocking lower would force re-asserting Stripe call shape work the lower layer pins. Mocking at the service-edge keeps this slice focused on the ROUTE contract (gating + audit-write + response shape). |
| Pin the instant fee MIN $0.50 floor as a separate test? | **Yes — load-bearing.** A regression that dropped the `Math.max(..., 0.50)` would credit small-balance users 1.5% instead of the floor. The fixture is unambiguous: $10 balance → fee MUST be $0.50, not $0.15. |
| Pin the "Stripe throws, endpoint still 200" branch in finances? | **Yes — explicitly documented.** The route's docstring says "Stripe hiccup falls through with zeros — we log and keep the endpoint responsive rather than 500ing." A regression that re-threw would make the tenant dashboard 500 on Stripe outages instead of degrading gracefully. |
| Fix the disbursements cleanup gap or work around inline? | **Fix the helper.** Third time this exact pattern surfaced. The helper's job is centralized cleanup; the workaround in stripeConnectWebhooks.test.ts (line ~190 inline pre-clean) is now redundant + can be deleted in a future hygiene pass. Not deleting it here — out of scope, and harmless. |
| Use AppError shape `error.message` or string? | **String.** Verified in middleware/errorHandler.ts:39 — `res.status(...).json({ success: false, error: err.message })`. The shape is `{ error: '<message>' }`, not `{ error: { message: '<message>' } }`. Common mistake (caught by first test run). |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **2724 tests across 146 files,
  0 failures**, 70.01s. **Fifty-second consecutive
  fully-green full-suite run.**
- 31 new test cases in this slice.
- 1 test-infra fix (disbursements cleanup gap).
- 0 production source bug fixes — routes were clean.

### Bugs caught during test authoring

1. **`cleanupAllSchema` missing `DELETE FROM disbursements`**
   — would have surfaced anywhere a test wrote a
   disbursement (any future POST /me/withdrawals test).
   Fixed in the central helper. Third instance of this
   pattern; explicit comment block added cross-referencing
   S445 / S446.

2. **(Author's own test bug)** Initial assertions used
   `res.body.error.message` shape; actual AppError-handler
   shape is `res.body.error` as a string. Caught by first
   run, fixed both assertions.

## Services / Routes audit — progress

### Routes still uncovered after S449

```
announcements.ts          (20 lines — stub)
auth.ts                   (578 lines — needs careful slice)
background.ts             (1095 lines — partial coverage via
                           background.test.ts + checkrProvider
                           tests; full route slice deferred)
books.ts                  (large — has partial test)
documents.ts              (32 lines — stub-like)
fitness.ts                (size TBD — likely standalone tracker
                           subsystem, low priority)
subleaseInvitations.ts    (269 lines — paired with subleases
                           tests already partial)
tenants.ts                (large — partial via
                           tenants-profile-dashboard.test.ts)
```

Money-flow trio CLOSED in S449.

## Items deferred — what S450 could target

### Continue route audit

**Recommend S450 = `auth.ts` route coverage.** Login,
register, email-verify, password-reset surfaces. ~580 lines.
Real-security path; high bug-surface; existing tests cover
only the verification edge cases. Single-session slice.

**Alternatives:**
- subleaseInvitations.ts (~270 lines, money-adjacent)
- background.ts route layer (Checkr integration, ~1095 lines)
- Validation-hygiene cleanup: surface S408 findings to Nic
  to unblock the backlog
- A different pivot if Nic redirects

### Validation-hygiene backlog (16 items, mostly Nic-pending)

Unchanged. S449 didn't reduce.

### Cumulative bug-sweep totals (post-S449)

- **54 production / infra bug fixes** (S448 53 +
  cleanupAllSchema disbursements gap) + 1 documented
  finding (posTax rounding mismatch from S439, still
  pending Nic decision)
- 16 architectural / validation findings remaining
  (Nic-pending)
- 2724 tests across 146 files
- Suite baseline: **67-71s on a clean machine**

## What S450 should target

**Recommended: `auth.ts` route coverage** — the largest
small-uncovered surface. Real-security; auth bugs are
typically high-severity. Login + register + email-verify +
password-reset; should yield 25-35 cases.

**Alternatives:**
- subleaseInvitations.ts (money-adjacent)
- background.ts route slice
- Surface S408 finding to Nic

---

End of S449 handoff. **Money-flow route triplet shipped —
31 tests covering withdrawals (Stripe Payout firing + audit
row + idempotency key), finances (Connect balance + ledger
entries + Stripe-throws degradation), disbursements (list
scoping + LEFT JOIN tolerance).** Plus one test-infra fix
(disbursements cleanup — third in the sequence).

2724 tests / 146 files / 0 failures. Fifty-second
consecutive fully-green full-suite run.

**54 cumulative production / infra bug fixes** + 1
documented finding still pending Nic review. Services
audit COMPLETE (S448); route audit started.
