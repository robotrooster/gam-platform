# Session 310 — closed

## Theme

Closed the FlexPay side of the FlexSuite cross-product
enrollment-restriction lever (Consumer ToS § 9.1.4(i)) and
removed the dead tenant-portal OTP UI carried over from S155.

The S309 handoff framed "OTP exclusion enforcement" as a
bigger gap than it actually was — recon showed most of the
wiring was already in place across `services/otp.ts`,
`services/flexCharge.ts` (S261), the NSF cooldown writers,
and the schema columns. The genuine remaining gaps were
narrow:

1. **FlexPay enrollment had no FlexDeposit-active gate.**
   `getFlexPayEligibility` checked ach_verified +
   flexpay_disqualified_until + active_lease, but not whether
   the tenant had an in-flight FlexDeposit installment plan.
   FlexCharge (S261) and OTP (services/otp.ts) both already
   honored the plan-active signal; FlexPay was the missing
   FlexSuite consumer of the same policy lever.
2. **Tenant portal had a dead OTP enrollment modal +
   qualification card** that still posted to the 410-Gone
   `/tenants/enroll-on-time-pay` endpoint (deprecated at
   S155 when OTP moved to landlord-only). Per the
   `project_flexsuite_otp_hidden.md` memory ("OTP inverse —
   landlord-only, never tenant"), the tenant portal must
   surface zero OTP framing.

## Items shipped

### S310 — FlexPay FlexDeposit-active gate

**`apps/api/src/services/flexpay.ts`** —
`getFlexPayEligibility` extended:
- New `flex_deposit_active` blocker added to the
  `FlexPayEligibility.blockers` union.
- New `SELECT id FROM security_deposits WHERE tenant_id = $1
  AND flex_deposit_enabled = TRUE AND flex_deposit_plan_status
  IN ('active', 'accelerated')` query mirrors the FlexCharge
  S261 gate. When the lookup returns a row, the blocker fires.
- Comment block documents the SLA § 9.1.4(i) cross-product
  restriction lever and notes that the plan-status signal
  (vs. installments_remaining) is consistent with FlexCharge.

The `enrollFlexPay` error path picks up the new blocker
automatically via `elig.blockers.join(', ')` — no separate
edit needed.

### S310 — Dead tenant-portal OTP UI removal

**`apps/tenant/src/main.tsx`** — ServicesPage cleanup:
- Removed `otpModal` state + `setOtpModal`.
- Removed `incomeDay` state + `setIncomeDay`.
- Removed `otpMut` mutation (was POSTing to the 410-Gone
  `/tenants/enroll-on-time-pay` endpoint).
- Removed the OTP Qualification Status card (lines 1129-1153
  in the pre-edit file) — showed deposit/ACH/OTP step
  indicators plus an "OTP qualified since X" alert.
- Removed the OTP enrollment modal (lines 1155-1175 in the
  pre-edit file).

The card-level FlexPay/FlexDeposit/FlexCredit service
catalog at the top of ServicesPage stays in place — those
are tenant-facing products and the memory's OTP-only
prohibition doesn't extend to them.

## Files touched

```
apps/api/src/services/flexpay.ts         (FlexPay eligibility gate)
apps/tenant/src/main.tsx                 (dead OTP UI removed)
SESSION_310_HANDOFF.md                   (this file)
```

No migrations, no schema changes. No legal-doc changes —
the SLA § 9.1.4(i) lever was already drafted; this session
made it operational for FlexPay.

## Decisions made during build

| Question | Decision |
|---|---|
| Which FlexDeposit-active signal — `installments_remaining > 0` (OTP pattern) or `plan_status IN ('active','accelerated')` (FlexCharge S261 pattern)? | **plan_status** — consistent with the more recent FlexCharge gate. Functionally equivalent (an accelerated plan has zero remaining but is still in-flight on the balance), and using a single canonical signal across FlexPay + FlexCharge makes the cross-product enforcement consistent. |
| Hard-block FlexPay enrollment, or surface "may restrict at GAM's discretion" warning? | **Hard-block.** The SLA language is permissive ("may be restricted at GAM's discretion"), but a broader gate is within discretion and matches the FlexCharge posture. Nic can soften to discretionary if a real case arises. |
| Remove the entire OTP qualification status card, or just the enrollment modal? | **Entire card.** The card explicitly surfaces "On-Time Pay Status" copy to tenants, which violates the OTP-inverse principle. The underlying signals (ach_verified + deposit_funded) are still surfaced through their own dedicated cards (AchVerifyForm at line 1124, FlexDeposit installment progress in the FlexDeposit modal). |
| Show a friendly label for `flex_deposit_active` in the tenant FlexPay modal, or accept the raw "Not eligible: flex_deposit_active" error string? | **Raw, for now.** Matches existing modal behavior for the other blockers (`ach_unverified`, `tenant_suspended_nsf`, `no_active_lease` all render raw). Modal error friendliness is a separate polish pass. Note: the modal-open gate at the ServicesPage card uses `me?.achVerified` (broken camelCase read — see "carryover bugs" below), so in practice FlexPay enrollment is already pre-blocked at the card level for most tenants; the backend gate is the load-bearing safety regardless. |

## Verification

- `grep -rn "flex_deposit_active" apps/` — present in
  `services/flexpay.ts` (type + push), `services/otp.ts`
  (the existing parallel gate), and
  `apps/landlord/src/pages/OtpPage.tsx:43` (existing label
  dictionary). Cross-product enum tokens consistent.
- `grep -n "otpModal\|otpMut\|incomeDay\|setOtpModal" apps/tenant/src/main.tsx`
  — 0 results. No orphan references after the removal.
- `npx tsc --noEmit` clean on `apps/api`, `apps/tenant`,
  `apps/landlord` (all 0 errors).
- No migration applied this session — code-only changes
  against existing schema.

## Carryover bugs discovered during recon (not fixed in S310)

1. **Tenant portal camelCase reads against snake_case API.**
   `apps/tenant/src/lib/api.ts` does no response transform;
   `apps/tenant/src/main.tsx` ServicesPage reads
   `me?.flexpayEnrolled`, `me?.achVerified`,
   `me?.depositFullyFunded`, `me?.otpQualifiedAt`,
   `me?.flexDepositEnrolled`, etc. (camelCase) but `GET
   /tenants/me` returns raw `t.*` columns in snake_case
   (`flexpay_enrolled`, `ach_verified`, etc.).
   Result: every `me?.fooBar` returns `undefined`, the
   `?? false` / `?? null` fallbacks kick in, and the card
   silently always shows the unenrolled/locked state.
   Equivalent to the PropertiesPage bug noted in S309
   (`requiresBookingAcknowledgment` / `subleasingAllowed`
   broken-camelCase reads).

   **Practical effect during S310:** the ServicesPage FlexPay
   card's `locked: !me?.achVerified` always evaluates to
   `locked: true`, so tenants can't open the FlexPay modal
   regardless of their actual ACH state. The backend
   `getFlexPayEligibility` gate I added today is the
   load-bearing safety; once the camelCase bug is fixed, the
   backend gate ensures FlexDeposit-active tenants still
   can't enroll.

   Likely the same pattern exists across the tenant portal.
   Worth a dedicated session — see "S311 candidates" below.

2. **Deposit-return ↔ unpaid-installment offset semantics.**
   `services/depositReturn.ts` only sweeps unpaid `payments`
   rows (S180); `flex_deposit_installments` rows in
   `pending`/`failed`/`defaulted` status are not directly
   pulled. The S260/S262 model treats unpaid installments as
   reducing `security_deposits.collected_amount` (the deposit
   pool), so the landlord disbursement reflects what's
   actually in escrow rather than what was promised.
   Functionally close to the SLA § 9.1.4(iii) "contractual
   offset right" framing but legally a different mechanism.
   Flagged in the S309 handoff; needs Nic's read before any
   change.

## Items deferred (cross-session docket)

- Consumer-side retention framing decision (S300).
- Campground Master import path (Nic-blocked on sample).
- 2FA fan-out (walkthrough-blocked).
- Yardi GL-export columns, Rentec template (S293).
- Stats tile on admin Overview (S295/S296).
- PII redaction in admin list (S295).
- Per-platform notes / review history display (S296).
- Email notification deep links (S298).
- FlexCharge Business Account Agreement signature capture
  (S309 option B — still queued).
- FlexDeposit eligibility-check workflow (S309 option C).
- Standalone POS-operator auth (S309 option D).
- Deposit-return ↔ unpaid-installment offset architecture
  call (carry from S310).

## Nic-pending (unchanged)

- Stripe live keys.
- Resend domain verification.
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.
- Consumer-side retention framing decision (S300).
- FlexCredit Lender partner selection.
- SLA § 9.1.4(iii) deposit-return offset framing — keep the
  S260/S262 mechanism (collected_amount-as-pool) and amend
  the SLA copy to match, or rework the deposit-return code
  to extract unpaid installments as a separate deduction
  line?

## What S311 should target — options breakdown

**A. Fix the broken tenant-portal camelCase reads** ←
*recommended primary*

The longest-standing silent bug surfaced across the last
three sessions. Direct user impact: tenants on ServicesPage
see the wrong locked/enrolled state for FlexPay,
FlexDeposit, ACH verification, credit reporting. Closing
this also unblocks the FlexPay locked-state surfacing for
the new `flex_deposit_active` blocker (the backend gate
I shipped today becomes user-visible at the card level).

**Scope (one focused session):**
- Audit every `me?.fooBar` read in `apps/tenant/src/main.tsx`
  + other tenant pages. Cross-check against the snake_case
  fields returned by `GET /tenants/me`,
  `/tenants/flexpay`, `/tenants/flexdeposit`,
  `/tenants/credit-reporting`, etc.
- Two paths:
  - **(a) Fix the reads.** Change every consumer to read
    snake_case (lowest risk, minimal touch).
  - **(b) Add a camelCase response transform.** Adds a layer
    in `apps/tenant/src/lib/api.ts` that snake-to-camels
    every response body. Risk: silent broken aliases (`id` →
    `id`, `created_at` → `createdAt`) may break joins/queries
    that re-key by snake_case for backend round-trips.
  - Recommend (a) — surgical, lower risk, matches the rest
    of the codebase.
- Same audit is needed in `apps/landlord/src/pages/PropertiesPage.tsx`
  (S309 finding: `requiresBookingAcknowledgment` /
  `subleasingAllowed` broken).
- Browser walk after fixing — confirm the FlexPay card now
  shows the correct enrolled state, the FlexDeposit card
  shows the correct progress, etc.

**B. FlexCharge Business Account Agreement signature capture**

Direct continuation of S308/S309's FlexCharge thread. The
template exists but no flow presents it for e-signature at
account creation. Variable-substitution layer + signature
route + audit table. Leverages whatever FlexDeposit SLA
signing infra S307 left behind. Bounded one-session work.

**C. Deposit-return architecture call**

Decide between keeping the S260/S262
collected_amount-as-pool model (and amending SLA § 9.1.4(iii)
to match) vs. extracting unpaid `flex_deposit_installments`
rows as a separate deduction line in `services/depositReturn.ts`.
Half-session: Nic's call + the chosen wiring.

**D. FlexDeposit eligibility-check workflow** *(carried
from S309)*

Bigger product surface. Two sessions minimum: rules-based
qualification algorithm + tenant-portal eligibility surface
+ audit persistence. Needs product input on what signals
qualify.

**E. Standalone POS-operator auth** *(carried from S309)*

Three-session scope. Auth-side widening to make the legal
layer's "Business Account Owner" framing real for non-
landlord POS operators.

**Recommendation:** **A**. The camelCase bug bites all three
of the last three sessions' work in practice (S309
FlexCharge toggle, S310 FlexPay gate, S308 ServicesPage
surface). Fixing it makes the recent backend work visible
to the tenant. Bounded scope, no product calls needed.

---

End of S310 handoff. Closed clean. Context at handoff point
per CLAUDE.md guidance — start S311 fresh.
