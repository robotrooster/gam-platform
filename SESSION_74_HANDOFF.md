# Session 74 Handoff

**Theme:** Item 18 Batch 3 — lease-adjacent enums (lease_tenants + lease_documents + lease_fees, 10 CHECKs total). Audit + drift fix.

Single small batch.

## Findings

**9 of 10 CHECKs already centralized in `packages/shared/src/index.ts`** (S23d Tier 1 work). Cross-checked each against the DB CHECK:

| Table.column | Shared export | Match? |
|---|---|---|
| lease_documents.document_type | `LEASE_DOCUMENT_TYPES` | ✓ |
| lease_documents.status | `LEASE_DOCUMENT_STATUSES` | **drifted** (see below) |
| lease_document_signers.status | `LEASE_DOCUMENT_SIGNER_STATUSES` | ✓ |
| lease_fees.due_timing | `FEE_DUE_TIMINGS` | ✓ |
| lease_fees.fee_type | `FEE_TYPES` (20 values) | ✓ |
| lease_tenants.role | `LEASE_TENANT_ROLES` | ✓ |
| lease_tenants.status | `LEASE_TENANT_STATUSES` | ✓ |
| lease_tenants.financial_responsibility | `FINANCIAL_RESPONSIBILITIES` | ✓ |
| lease_tenants.added_reason | `LEASE_TENANT_ADDED_REASONS` | ✓ |
| lease_tenants.removed_reason | `LEASE_TENANT_REMOVED_REASONS` | ✓ |

## The drift

**`LEASE_DOCUMENT_STATUSES` was missing `'execution_failed'`.** The DB CHECK lists 6 values; the shared const had 5. The `'execution_failed'` status is actively written by `esign.ts:1905` when the post-sign execute step (lease build / cascade / move-in invoice) raises — the doc gets parked for admin investigation. Multiple guards in esign.ts (lines 1599, 1753, 1802) read this status. So it's been a real, used status that anyone consuming `LeaseDocumentStatus` from shared would have failed to recognize.

## Fix

- **`packages/shared/src/index.ts`** — added `'execution_failed'` to `LEASE_DOCUMENT_STATUSES` const, with a label entry in `LEASE_DOCUMENT_STATUS_LABEL`. Comment block updated to document what the new state means and why it exists separately from `voided`.
- **No consumer breakage** — `LEASE_DOCUMENT_STATUSES` is referenced in shared but no exhaustive switch statements key on `LeaseDocumentStatus` across the codebase, so widening the union didn't surface any missing-case errors. API + landlord typecheck both clean.

## Files touched

- packages/shared/src/index.ts
- DEFERRED.md (Batch 3 tombstoned)
- SESSION_74_HANDOFF.md (this file)

## Validation

- Shared package rebuilt cleanly.
- `cd apps/api && npx tsc --noEmit` → exit 0
- `cd apps/landlord && npx tsc --noEmit` → exit 0

## DEFERRED.md update

Item 18 Batch 3 → SHIPPED S74. One-line tombstone with the drift summary.

## Pre-launch blockers still open

- Item 16 — Stripe ACH credit firing (held until 2026-05-05).
- Item 2 — FCRA adverse action notice infrastructure.
- Item 10 — Utility billing subsystem (multi-day).
- Item 11 — Master Schedule finish-or-strip (needs Nic's product call).
- Item 14 — POS app completion (multi-day).
- Item 15 — E-sign frontend visual + e2e smoke.
- Item 18 Batches 4–5 (payment-flow, operational enums).
- Item 19 — Email systems consolidation.

## What next session should target

Top picks (none Stripe-blocked):
1. **Item 18 Batch 4 — payments/invoices/disbursements/security_deposits (~10 CHECKs).** DEFERRED note: "will need re-examination after 16a lands — payment.type and entry_description may evolve under the platform-mediated model." Worth doing now while 16a is fresh in mind.
2. **Item 18 Batch 5 — operational subsystem enums** (maintenance, utility, tenant, background-check). Also tractable.
3. **Item 19 — Email consolidation** — bigger blast radius; deserves its own session.

Today is 2026-05-02. Stripe rate work resumes 2026-05-05.

This Claude Code run has spanned S66-S74 (nine internal batches in one external session).
