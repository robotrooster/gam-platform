# Session 437 — closed

## Theme

**Fourteenth services-audit session. Closes the S428
deferral on pm.ts: the 5-function invitation lifecycle
(send / accept / reject / revoke / expire). 26 tests
pinning all the S159 banking-readiness guards, the
expired-on-accept terminal-state flip, the conflict-
replace handshake, and the cron-driven sweep.**

Suite at S436 close: **2332 / 134 files**.
Suite at S437 close: **2358 / 135 files** (+26 cases,
+1 file). 0 failures. Runtime **66.07s**.
Forty-first consecutive fully-green full-suite run.

Zero tsc regressions.

## What shipped

### `services/pmInvitations.test.ts` — 26 cases

Five invitation-lifecycle functions covered against real
DB rows. No Stripe surface — all gates are
schema-driven.

**`sendPropertyInvitation` — guard rails (8)**
- Property not found → 404
- Property landlord_id mismatch (caller passed wrong
  landlord) → 400
- pm_company not found → 404
- pm_company inactive → 400
- proposedFeePlanId not found → 404
- fee plan belongs to a DIFFERENT PM company → 400
  (cross-PM-fee-plan security boundary)
- fee plan inactive → 400
- Existing pending invite for (pm_company, property)
  pair → 409

**`sendPropertyInvitation` — happy (1)**
- Returns invitationId + token + expiresAt ~72h out;
  token is URL-safe base64 (matches `[A-Za-z0-9_-]+`);
  row inserted in 'pending' status with proposed scope
  + fee plan stamped

**`acceptPropertyInvitation` — guard rails (6)**
- Token not found → 404
- Status not pending (already-accepted) → 409 with
  current status in the message
- Expired (expires_at in past) → 410; status flipped
  to 'expired' as a side-effect of the function
- S159 banking guard: owner_to_pm + manage scope +
  Connect NOT ready → 409 with the "Banking
  onboarding incomplete" copy
- S159: pm_to_owner direction skips banking guard
  (PM is requesting visibility, not money routing)
- view scope skips banking guard even on owner_to_pm

**`acceptPropertyInvitation` — happy + replace (3)**
- Happy "manage": properties.pm_company_id +
  pm_fee_plan_id written; invitation flipped to
  'accepted' with accepted_user_id stamped;
  replaced_pm_company_id NULL
- Conflict (property already linked to a DIFFERENT
  PM) + replace=false → 409 with override hint
- Conflict + replace=true → succeeds; properties.pm_company_id
  overwritten; replaced_pm_company_id stamped with
  the prior PM id (audit trail)

**`rejectPropertyInvitation` (3)**
- Happy: status='rejected'; rejected_at + rejected_reason
  stamped
- Token not found → 404
- Non-pending invitation → 404 (WHERE clause filter
  excludes; same error message as not-found)

**`revokePropertyInvitation` (2)**
- Happy: status='revoked'; revoked_at +
  revoked_by_user_id stamped
- Non-pending invitation → 404

**`expireStaleInvitations` (3)**
- No pending past expiry → returns 0
- Pending past expiry → flipped to 'expired';
  returns count
- Non-pending past-expiry rows untouched (e.g., a
  rejected row past expiry stays rejected)

## Items shipped

```
apps/api/src/services/
  pmInvitations.test.ts                 (NEW — 26 cases)
```

No source code changes. Service preserved as-is.

## Decisions made during build

| Question | Decision |
|---|---|
| New file or append to `pm.test.ts`? | **New file** (`pmInvitations.test.ts`). The S428 `pm.test.ts` covered only `getPmCompanyForProperty`; adding 26 more cases would dwarf the existing 5 and make the file harder to navigate. The semantic split — resolver vs lifecycle — also justifies it. |
| Pin every guard rail in sendPropertyInvitation individually? | **Yes.** Each guard is a discrete contract that prevents a different operator error (wrong landlord, wrong fee plan, dup invite). Combined tests would mask which guard regressed. |
| Pin the cross-PM-fee-plan security boundary? | **Yes — load-bearing.** A regression that drops the `fp.pm_company_id = $pm_company_id` check would let PM A invite themselves with PM B's fee plan, then collect under B's contract terms. Schema-level isolation is the defense; the test proves the code honors it. |
| Pin the expired-on-accept side-effect status flip? | **Yes.** The function deliberately flips status to 'expired' before throwing 410, so future accept attempts on the same token short-circuit to the "is expired, not pending" branch. A regression that throws without the flip would leave the row stuck in 'pending' until the cron sweep runs. |
| Pin the S159 banking guard for both directions + both scopes? | **Yes — symmetric guard with deliberate skips.** Three explicit tests: (a) owner_to_pm + manage + not ready → blocks; (b) pm_to_owner + manage skips; (c) owner_to_pm + view skips. Each skip is a deliberate design choice; a regression that dropped the per-direction or per-scope short-circuit would either over-block (UX hurt) or under-block (money goes to KYC-incomplete PM). |
| Pin the conflict-replace handshake audit trail? | **Yes — money-movement implication.** When replace=true is used, the prior PM loses the property assignment. The replaced_pm_company_id column is the audit trail that lets ops trace why a property's PM changed. A regression that dropped it would erase the chain of custody. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors).
- `npm test` in apps/api: **2358 tests across 135
  files, 0 failures**, 66.07s. **Forty-first
  consecutive fully-green full-suite run.**
- 26 new test cases.
- 0 production regressions.
- 0 new findings — service matches contract.

## Services audit — progress

Post-S437:

### Direct coverage (43 of 43 services); pm.ts now COMPLETE

S424–S433: 10 single-service slices.
S434–S436: stripeConnect.ts 12/12 functions.
S437: pm.ts invitation lifecycle (5 functions) +
  prior pm.ts coverage of getPmCompanyForProperty
  → pm.ts now 6/6 exports COMPLETE.

### Still UNCOVERED (~13 files post-S437)

Highest-value continuation candidates:
1. **otp.ts Stripe state-machine half** (S427
   continuation — disbursement firing, OTP success/
   failure path)
2. **flexpay.ts Stripe state-machine half** (S431
   continuation — advance firing, pull-day processing,
   NSF handling)
3. **flexCharge.ts billing/reconciliation half** (S425
   continuation — monthly statement generation, interest
   accrual, payment posting)
4. **DB-backed credit-ledger wrappers** (S429
   continuation — record*Event emitters with real
   subjects + dispute)
5. Plus ~8 smaller helpers (each less than ~150 lines)

## Items deferred — what S438 could target

### Continue services audit

**Recommend S438 = sweep through 2–3 smaller helpers
in a triplet slice** (similar to the S428 pdfStamp +
pm + landlordPassthrough pattern). Faster cadence on
the long-tail close-out before the heavy Stripe
state-machine halves.

**Alternatives:**
- otp.ts Stripe state-machine half (heavy single)
- flexpay.ts Stripe state-machine half (heavy single)
- flexCharge.ts billing half (heavy single)
- DB-backed credit-ledger wrappers (medium)

### Validation-hygiene backlog (16 items)

Unchanged from S427.

### Cumulative bug-sweep totals (post-S437)

- **47 production bug fixes** (S437 is direct coverage)
- 16 architectural / validation findings remaining
- 2358 tests across 135 files
- Suite baseline: **60-66s on a clean machine**

## What S438 should target

**Recommended: triplet slice through smaller helpers**
to maintain cadence on the long-tail before tackling
the heavy Stripe state-machine continuations.

**Alternatives:**
- otp.ts Stripe state-machine half
- flexpay.ts Stripe state-machine half
- flexCharge billing half
- DB-backed credit-ledger wrappers

---

End of S437 handoff. **PM invitation lifecycle slice
shipped — 26 tests pinning send / accept / reject /
revoke / expire, all S159 banking-readiness guards
across direction × scope, the expired-on-accept
terminal flip, and the conflict-replace handshake
with audit trail.**

2358 tests / 135 files / 0 failures. Forty-first
consecutive fully-green full-suite run.

**47 cumulative production bug fixes shipped across the
bug sweep.** Services audit: pm.ts now COMPLETE at
6/6 exports. Remaining work is continuation halves
on heavy state-machine services + ~8 smaller helpers.
