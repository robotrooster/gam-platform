# Session 75 Handoff

**Theme:** Item 18 Batch 4 — payment-flow enums (payments + invoices + disbursements + security_deposits). Pre-batch had only 1 of 8 enum CHECKs centralized. Per the DEFERRED note this needed re-examination after 16a; under the current model the existing CHECK values are correct, no widening required.

Single small batch.

## Findings

8 enum CHECKs across 4 tables. Only 1 was centralized in `packages/shared/src/index.ts` pre-S75 (`INVOICE_STATUSES`). The rest were either floating string literals or absent entirely.

| Table.column | Pre-S75 status |
|---|---|
| invoices.status | `INVOICE_STATUSES` ✓ |
| payments.status | dead `enum PaymentStatus` (TS-style enum, zero consumers) |
| payments.type | not centralized |
| payments.entry_description | not centralized (NACHA CCD/PPD field) |
| disbursements.status | not centralized |
| disbursements.trigger_type | not centralized |
| security_deposits.held_by | not centralized |
| security_deposits.status | not centralized |

## Fixes

**`packages/shared/src/index.ts`** — added 7 const+type pairs alongside the existing `INVOICE_STATUSES` block:

- `PAYMENT_STATUSES` (`pending|processing|settled|failed|returned`) + `PaymentStatus`
- `PAYMENT_TYPES` (`rent|fee|deposit|utility|float_fee|late_fee|platform_fee`) + `PaymentType`
- `PAYMENT_ENTRY_DESCRIPTIONS` (`RENT|SUBSCRIP|DEPOSIT|UTILITY|ONTIMEPAY|LATEFEE`) + `PaymentEntryDescription`. NACHA CCD/PPD entry description field — uppercase, max 10 chars per spec.
- `DISBURSEMENT_STATUSES` + `DisbursementStatus`
- `DISBURSEMENT_TRIGGER_TYPES` (`auto_friday|manual_on_demand|otp_legacy`) + `DisbursementTriggerType`. Comment notes `otp_legacy` is reserved for the pre-16a OTP cycle and isn't actively written under 16a — kept in the union to match DB CHECK.
- `SECURITY_DEPOSIT_HELD_BY_VALUES` (`gam_escrow|landlord`) + `SecurityDepositHeldBy`. Comment flags this is **distinct from properties.deposit_handling_mode** (which uses `'landlord_held'`, not bare `'landlord'`) — both centralizations exist and are NOT interchangeable.
- `SECURITY_DEPOSIT_STATUSES` + `SecurityDepositStatus`

**Killed dead enum:** `export enum PaymentStatus` at line 324 had zero consumers (verified via grep). Replaced with a comment pointer to the new const+type pattern. Resolved a `TS2567` collision with the new `type PaymentStatus` declaration.

## Post-16a re-examination

Per the DEFERRED note, payment.type and entry_description "may evolve under the platform-mediated model." Confirmed they have not — the current values still cover the active code paths under 16a:
- `payment.type='rent'` is the predominant path; `'fee'`, `'deposit'`, `'utility'`, `'late_fee'`, `'float_fee'` map to lease_fees / utility / OTP flows
- `payment.type='platform_fee'` is the GAM platform-fee charge — currently unused under 16a (banking_spread now flows through `platform_revenue_ledger`, not the payments table) but kept for backwards-compat with any historic rows
- `entry_description` is NACHA-spec, doesn't change post-16a

No widening or value drops needed. Centralization captures current shape.

## Files touched

- packages/shared/src/index.ts
- DEFERRED.md (Batch 4 tombstoned)
- SESSION_75_HANDOFF.md (this file)

## Validation

- Shared package rebuilt cleanly.
- `cd apps/api && npx tsc --noEmit` → exit 0
- Consumer drift retrofit deferred — adding these constants to shared without touching consumers is the contract; future PRs can adopt as they touch each call site.

## DEFERRED.md update

Item 18 Batch 4 → SHIPPED S75 with summary of new exports and the dead-enum cleanup.

## Pre-launch blockers still open

- Item 16 — Stripe ACH credit firing (held until 2026-05-05).
- Item 2 — FCRA adverse action notice infrastructure.
- Item 10 — Utility billing subsystem (multi-day).
- Item 11 — Master Schedule finish-or-strip (needs Nic's product call).
- Item 14 — POS app completion (multi-day).
- Item 15 — E-sign frontend visual + e2e smoke.
- Item 18 Batch 5 — operational subsystem enums (maintenance, utility, tenant, background-check).
- Item 19 — Email systems consolidation.

## What next session should target

1. **Item 18 Batch 5** — operational enums. Last Item 18 batch.
2. **Item 19 — Email consolidation** — bigger blast radius; deserves its own session.
3. **Item 11 — Master Schedule** — needs Nic's build-vs-strip call.

Today is 2026-05-02. Stripe rate work resumes 2026-05-05.

This Claude Code run has spanned S66-S75 (ten internal batches in one external session).
