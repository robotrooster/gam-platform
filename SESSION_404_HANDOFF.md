# Session 404 — closed

## Theme

**bankAccounts.ts gap-close slice — closes the file at
4/4 (100%). 23 new test cases, 0 production bug fixes
(clean slice — routes properly per-user-scoped, numbers
encrypted at rest, never returned to clients).**

Suite at S403 close: **1654 / 90 files**.
Suite at S404 close: **1677 / 91 files** (+23 cases,
+1 file). 0 failures. Runtime 1469.24s. Eighth
consecutive fully-green full-suite run.

Zero tsc regressions.

Third zero-bug slice of the sweep (after S398 leases
and S402 notifications).

## Items shipped

### Test coverage — 23 cases / 4 describe blocks

New file: `apps/api/src/routes/bankAccounts.test.ts`
(~340 lines)

**GET /api/bank-accounts — 4 cases**
- Returns only caller's accounts
- Returns [] when caller has none
- Never returns `account_number_encrypted` in payload
  (SAFE_COLUMNS allowlist contract)
- Archived accounts still appear (ORDER BY status ASC)

**POST /api/bank-accounts — 10 cases**
- Happy: 201 with last4 + encrypted blob on DB row
- Routing number with formatting (dashes) stripped + validated
- Invalid routing number checksum → 400
- Routing number wrong length → 400
- Account number < 4 digits → 400
- Account number > 17 digits → 400
- Nickname required → 400
- Invalid accountType enum → 400
- Invalid accountHolderType enum → 400
- Nickname trimmed before insert

**PATCH /api/bank-accounts/:id — 5 cases**
- Happy: updates nickname only
- Immutability: routing/account fields in body ignored
- Cross-user → 404 (does NOT leak existence as 403)
- Unknown id → 404
- Empty nickname → 400

**POST /api/bank-accounts/:id/archive — 4 cases**
- Happy: status flips to archived; encrypted blob persists
- Cross-user archive → 404; row NOT touched
- Idempotent: re-archive stays archived (no error)
- Unknown id → 404

## Architectural observations (no fix in slice)

### Cross-user 404-vs-403 information-leakage posture

The PATCH + archive routes return 404 for cross-user
requests (UPDATE clause includes `user_id = $1`, so the
row simply isn't matched). This is the **correct
security posture** — returning 403 would confirm to an
attacker that the UUID exists in the system, even
though they can't modify it. The route's silent-no-op
pattern was confirmed deliberate in S402 cross-user
testing; pinning it here as a documented contract.

### Soft-delete persistence verified

The archive route's contract is "row + encrypted blob
persist forever for GAM audit." Test pins the encrypted
blob is intact after archive — a future refactor that
does a hard delete instead would break the audit trail
silently. Test catches the regression.

## Files touched

```
apps/api/src/routes/
  bankAccounts.test.ts                 (NEW — ~340 lines,
                                         23 cases)
```

No production code touched. No migrations. No schema
changes. No frontend touched.

## Decisions made during build

| Question | Decision |
|---|---|
| Test with a real ABA routing number? | **Yes — 011000015** (Federal Reserve Bank of Boston). Both checksum and prefix valid. Using a deliberately-crafted invalid one for the negative-case test makes the contract concrete. |
| Mock the encryption helper? | **No.** Real encryption with the .env-loaded BANK_ENCRYPTION_KEY. Pinning that the encrypted blob is non-empty + not-equal-to-plaintext exercises the actual cryptographic path. |
| Test that account_number_encrypted is never in the response payload? | **Yes — three places.** GET, POST, and implicitly in PATCH/archive (via SAFE_COLUMNS allowlist). This is the security contract; a future SELECT * regression would break it silently. |
| Pin the 404-vs-403 choice on cross-user attempts? | **Yes — explicit comment in the test.** The choice is deliberate (don't leak row existence) and a future "be more helpful" refactor would weaken security. |
| Test the soft-delete blob-persistence contract? | **Yes — read the encrypted blob from DB after archive** to verify the row + crypto data survive. The contract is documented in the file header; pin it. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **1677 tests across 91 files,
  0 failures**, 1469.24s. **Eighth consecutive fully-
  green full-suite run.**
- 23 new test cases.
- 0 production bug fixes (clean slice).
- 0 production regressions.

## Items deferred — what S405 could target

### Medium-band batch remaining

After bankAccounts.ts close (4 routes):
- **posCustomerOnboarding.ts — 3 routes (253 lines)**
- **stripe.ts — 5 routes (279 lines)**
- **payments.ts — 4 routes (429 lines)**
- **reports.ts — 5 routes (489 lines)** — largest;
  most likely to surface bugs given financial-data
  scope.

Total remaining medium-band: **17 routes across 4 files.**

**Recommend S405 = posCustomerOnboarding.ts gap-close.**
Smallest by route count (3 routes); peer to the
already-shipped slices in surface size.

### Validation-hygiene backlog (now 24 items)

Unchanged from S403.

### Pending Nic decisions

Unchanged.

### Per directive: fix all bugs before Checkr

Cumulative bug-sweep totals (post-S404):
- **40 production bug fixes** (unchanged — clean slice)
- 24 architectural / validation findings flagged
- 1677 tests covering ~383 of 506 audited routes (76%)

## Items deferred (cross-session docket, post-S404)

Unchanged from S403.

## Nic-pending

Unchanged.

## What S405 should target

**Recommended: posCustomerOnboarding.ts gap-close**
(3 routes, 253 lines). Smallest remaining medium-band
file by route count.

**Alternatives:**
- stripe.ts (5 routes, 279 lines)
- payments.ts (4 routes, 429 lines)
- reports.ts (5 routes, 489 lines — most bug potential)
- Validation-hygiene micro-session (24-item backlog +
  S398 product decisions)
- background.ts + Checkr (defer until route-test
  sweep closes)

---

End of S404 handoff. **bankAccounts.ts arc CLOSED at
4/4 routes (100%).** Slice / 23 tests / 0 production
bug fixes (clean — routes already correctly-scoped).
Third zero-bug slice of the sweep.

1677 tests / 91 files / 0 failures. Eighth consecutive
fully-green full-suite run.

**40 cumulative production bug fixes shipped across the
bug sweep.**
