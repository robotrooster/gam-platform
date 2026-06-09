# Session 180 — closed

## Theme

A1 + A2 from the S177 product walkthrough. **A1**: extend the
deposit-return service to auto-sweep all outstanding tenant
balance items (unpaid rent, unpaid utilities, late fees, fees)
into the deposit deduction at finalize time, with a new
`paid_via_deposit` payment status as the audit-trail marker.
**A2**: new admin-trigger `POST /api/leases/:id/bill-fee`
endpoint for landlord-initiated one-off charges (early
termination fee, other fee). Both decisions locked at S177;
this session shipped the data layer cleanly. UI surfaces are
follow-on sessions.

## What S180 shipped

### A1 — auto-sweep unpaid payments into deposit deduction

#### Schema migrations

`20260508000000_payments_paid_via_deposit_status.sql`:
- Drops `payments_status_check` and re-creates with new
  `paid_via_deposit` value alongside existing
  `pending | processing | settled | failed | returned`.
- Distinct from `settled` (real money flow) — clear audit trail.

`20260508000100_deposit_returns_unpaid_balance.sql`:
- Adds `deposit_returns.unpaid_balance_amount numeric(10,2)
  NOT NULL DEFAULT 0`.
- Snapshot column for the auto-swept total. Mirrors the existing
  `cleaning_fee_amount` snapshot pattern.

#### Shared enum updated

`packages/shared/src/index.ts`: `PAYMENT_STATUSES` array now
includes `'paid_via_deposit'`. Maintains the single-source-of-
truth posture for the CHECK constraint vocabulary.

#### Service — `services/depositReturn.ts`

`calculateDepositReturn` now also pulls outstanding payment rows:
```sql
SELECT id, type, amount, due_date, entry_description, status
  FROM payments
 WHERE lease_id = $1
   AND status IN ('pending', 'failed')
   AND entry_description != 'DEPOSIT'   -- exclude prior gap rows
   AND amount > 0
```

Returns them as a typed array:
```ts
interface UnpaidBalanceLine {
  payment_id, type, amount, due_date, entry_description, status
}
```

Plus `unpaid_balance_total` summed into `total_deductions`.

`createOrFetchDraft` writes the snapshot into the new
`unpaid_balance_amount` column at draft create time.

`applyDeductionsToDraft` re-pulls live unpaid payments on every
call (a draft may sit for days; the unpaid set shifts).
Recomputes `unpaid_balance_amount` + `total_deductions` to stay
self-consistent.

`finalizeDepositReturn`:
- Re-queries unpaid payments inside the transaction with
  `FOR UPDATE` so a concurrent webhook settle can't race.
- `UPDATE payments SET status='paid_via_deposit', settled_at=NOW(),
  notes=...` for all swept rows in one batch.
- Recomputes `total_deductions` / `refund_amount` / `gap_amount`
  using the live unpaid balance + stored landlord-controlled
  lines (cleaning_fee, damage_lines, other_deductions).
- Persists the live numbers in the final `UPDATE deposit_returns`
  so the row reflects exactly what was applied at finalize.

The existing refund / gap branches + credit-ledger emission
work unchanged against the live values.

### A2 — admin-trigger `/api/leases/:id/bill-fee`

In `apps/api/src/routes/leases.ts`, alongside the existing
deposit-return endpoints. Body shape:
```ts
{
  fee_type:    'early_termination_fee' | 'other_fee'
  amount:      number  // dollars, > 0, ≤ 1_000_000
  description: string  // optional, ≤ 500 chars; sensible default
  due_date:    string  // optional ISO date, defaults to today
}
```

Behavior:
- Validates calling user controls the lease's landlord
  (requirePerm + canManageLandlordResource).
- Resolves active primary tenant via `v_lease_active_tenants`;
  rejects 409 if the lease has no active primary.
- Inserts a `payments` row: `type='fee'`, `status='pending'`,
  `entry_description='SUBSCRIP'` (NACHA category for non-rent
  recurring/one-off lease fees).
- Notes field includes the S180-A2 marker + the admin-supplied
  description for audit trail.
- Returns `{ payment_id, fee_type, amount, due_date, description }`.

Tenant pays via the standard `/api/payments/:id/pay` flow against
the returned payment_id. If the tenant doesn't pay before
move-out, the A1 deposit auto-sweep pulls it in.

### What this session did NOT do

- **No frontend surface for A1.** The deposit-return draft UI
  (wherever it lives) doesn't yet render the
  `unpaid_balance_lines[]` array. The API surface is ready;
  rendering is a follow-on. Today landlords see the auto-sweep
  reflected in the `total_deductions` total but not as a
  line-item breakdown.
- **No frontend surface for A2.** No "Bill fee" button on the
  lease detail page. Backend endpoint is curl-ready; UI is the
  next session. Layout/copy is a quick product call when ready.
- **No webhook handler for `paid_via_deposit` settle event.**
  None needed — `paid_via_deposit` is a terminal status set by
  the finalize transaction. No Stripe charge, no webhook
  required.

### Files touched (S180)

```
apps/api/src/db/migrations/20260508000000_payments_paid_via_deposit_status.sql    NEW
apps/api/src/db/migrations/20260508000100_deposit_returns_unpaid_balance.sql      NEW
apps/api/src/db/schema.sql                                                         regenerated
packages/shared/src/index.ts                                                       (+ 'paid_via_deposit' in PAYMENT_STATUSES)
apps/api/src/services/depositReturn.ts                                             (+ UnpaidBalanceLine type + unpaid sweep in calculate/create/apply/finalize)
apps/api/src/routes/leases.ts                                                      (+ POST /:id/bill-fee endpoint)
```

### Verification

- `cd apps/api && npx tsc --noEmit` exit 0
- `cd apps/landlord && npx tsc --noEmit` exit 0
- `cd apps/tenant && npx tsc --noEmit` exit 0
- Both migrations applied via
  `npm run --workspace apps/api migrate`. Schema regenerated.
- Sweep query excludes `entry_description='DEPOSIT'` so a prior
  deposit-return gap row can't recursively roll into a new
  deposit-return calculation.
- FOR UPDATE inside the finalize transaction prevents the race
  where a webhook settles a payment between calculation and the
  paid_via_deposit flip.

## Decisions made (S180)

| Question | Decision |
|---|---|
| New status `paid_via_deposit` vs reuse `settled` with metadata? | New status. Clear audit trail; queries can filter `WHERE status='settled'` for actual-Stripe-money rows without false positives. The CHECK migration is small. |
| Snapshot `unpaid_balance_amount` on the row vs always re-query? | Snapshot. Mirrors the existing `cleaning_fee_amount` snapshot column. Pre-finalize state stays self-consistent without re-pulling payments on every read. Live re-query happens on `applyDeductionsToDraft` (already a write path) + at finalize (with FOR UPDATE locking). |
| Refresh totals on finalize, or trust the pre-finalize stored value? | Refresh. Drafts can sit days; the unpaid set shifts. The whole point of the sweep is that the deposit covers what's owed at finalize moment, not what was owed when the draft was created. |
| `bill-fee` on lease route or admin route? | Lease route. The action is per-lease (`/leases/:id/bill-fee` reads cleaner than `/admin/lease-fees/:leaseId/bill`), the auth posture matches other lease-detail mutations, and the natural caller is the lease detail page UI. |
| Allow arbitrary fee_type strings, or restrict to enum? | Restrict. `early_termination_fee` and `other_fee` are the two locked-decision use cases per S177 A2. Adding new types later is a one-line zod enum extension; over-restricting now is safer than allowing typo'd categories that pollute audit logs. |

## Carry-forward — what S181+ should target

### B3 surface UI on bookings (when Nic provides layout direction)

Pending acknowledgment indicators + "Mark acknowledged" button
on SchedulePage / unit detail / etc. Half-session.

### A1 frontend — line-item breakdown on deposit return draft

Render `unpaid_balance_lines[]` as a section above damage_lines
on whatever page hosts the deposit-return draft (likely
LeasesPage detail or a dedicated /deposit-returns route — needs
recon). Half-session.

### A2 frontend — "Bill fee" button on lease detail

Modal: fee_type select + amount + description + optional due_date.
On submit POST `/api/leases/:id/bill-fee`. Show success → pending
payment row appears on tenant /payments. Half-session.

### A3 — state-hardcoded deposit interest

Needs sourced state-by-state rate data + Nic on where to pull
from (HUD, state AG sites, legal counsel). Schema + per-state
seed migration + monthly accrual job + landlord deposit-summary
surface. ~2 sessions once data is in hand.

### B1+B2 coupled — material-change new-lease workflow + late-fee
edit confirm modal + addendum generator

Needs Nic on default notice period per change type, addendum
doc shape, default templates.

### C1 — 50-state property-state form catalog

Schema + seed data + UI. Per-state form research; ~2 sessions.

### D2 — Flex tenant suite + OTP landlord-side + launch-hide flag

Multi-session build (~3-5).

### Sublease subsystem
### POS multi-terminal sync + Stripe Terminal + EOD
### CSV imports for 8 competitors
### E2 — 4 npm upgrades
### F1 — Marketing rebuild (after Nic's positioning paragraph)

---

End of S180 handoff.
