# Session 193 — closed

## Theme

S188 deposit interest engine carry-forward: distinct credit-ledger
event for the statutory-interest-payout flow at lease end. Pre-
S193 the four `deposit_returned_*` events tracked the principal
flow only — interest was silently absorbed into the refund pool
math without a separate audit-trail entry. S193 adds
`deposit_interest_paid` as a first-class event type so reports
can distinguish principal-refund from statutory-interest-payout.

Two prior session pivots before settling on this scope:
1. `leases.security_deposit` deprecation — recon confirmed it's a
   2-session refactor (lease_fees CHECK extension + 15+ writers/
   readers + column drop). Re-deferred with sharper scope.
2. B1 late-fee addendum workflow — needs full addendum-with-
   tenant-notice flow (multi-session).

## What S193 shipped

### `deposit_interest_paid` event type added to v1 catalog

`packages/shared/src/index.ts:CREDIT_EVENT_TYPES` array picks up
the new value. Type union flows automatically to all consumers
via `CreditEventType = typeof CREDIT_EVENT_TYPES[number]`.

### Emit in `finalizeDepositReturn`

Fires whenever `interest_accrued > 0` at lease finalize, regardless
of refund/gap shape. Event_data captures:

```ts
{
  lease_id, deposit_return_id,
  interest_accrued_total,        // total interest accrued across all months
  interest_paid_to_tenant,       // MIN(interest_accrued, refund) — what tenant received
  interest_applied_to_deductions,// remainder absorbed by deductions
  principal_amount,              // total_deposit (helps reports separate principal vs interest)
  rate_pct_at_lease_end,         // most-recent accrual row's rate
  state_code,                    // most-recent accrual row's state
  accrual_months_count,          // total accrual rows recorded for this deposit
}
```

Rate context pulled from the most recent `security_deposit_interest_accruals`
row so the event records what was in effect at lease end (state
rate may have changed mid-tenancy due to annual catalog refresh
or landlord override updates).

### Principal-only thresholds for `deposit_returned_*` events

Pre-S193 the threshold check used `tenantPool` (principal +
interest) as the comparator, which meant a deposit that earned
$5 of interest could be classified `deposit_returned_full` when
the tenant only got back $1000 principal + $5 interest while
$0 was deducted. Post-S193 the threshold uses
`principalRefunded = MIN(refund, totalDeposit)` so the
classification is truly about principal flow:
- `principalRefunded >= totalDeposit` → full
- `0 < principalRefunded < totalDeposit` → partial
- `principalRefunded == 0` → zero (regardless of interest payout)

This is the cleaner semantic — interest is its own story, told
by the new `deposit_interest_paid` event.

### `emitDepositEvent` now records interest_accrued in event_data

Even when interest is zero, the existing deposit_returned_* events
now include `interest_accrued: 0` in event_data so the audit trail
is complete. Future analysis can scan these events to confirm a
lease had no statutory interest obligation (state not in catalog
+ no override).

### Frontend EVENT_LABEL maps updated

`apps/landlord/src/pages/TenantScreeningPage.tsx` and
`apps/tenant/src/main.tsx` both have local copies of EVENT_LABEL
(noted-as-duplicated in CLAUDE.md). Added
`deposit_interest_paid: 'Statutory deposit interest settled'` to
both.

### Files touched (S193)

```
packages/shared/src/index.ts                                            (+ 'deposit_interest_paid' in CREDIT_EVENT_TYPES)
apps/api/src/services/depositReturn.ts                                  (finalizeDepositReturn: principal-only thresholds + new deposit_interest_paid emission; emitDepositEvent signature gains interestAccrued param)
apps/landlord/src/pages/TenantScreeningPage.tsx                         (+ EVENT_LABEL entry)
apps/tenant/src/main.tsx                                                (+ EVENT_LABEL entry)
```

### Verification

- `cd packages/shared && npx tsc -b` → 0
- `cd apps/api && npx tsc --noEmit` → 0
- `cd apps/landlord && npx tsc --noEmit` → 0
- `cd apps/tenant && npx tsc --noEmit` → 0
- No schema migrations
- No formula version bump — `deposit_interest_paid` is a new
  forward-compat event type. The v1.0.0 formula seed doesn't
  have a scoring weight for it; events flow through the ledger
  but don't move the score until a future formula bump.

## Decisions made (S193)

| Question | Decision |
|---|---|
| Bump formula version (v1.0.0 → v1.1.0) to assign a scoring weight to deposit_interest_paid? | No. The event is purely informational (tenant got their statutory interest as required). Scoring weight is a separate product call: should "got interest paid" affect a tenant's credit score? Probably not — it's a landlord-compliance event, not a tenant-behavior event. Per CLAUDE.md: "formula version bumps via new migration, never mutate v1.0.0 in place." If we later decide it scores, that's a v1.1.0 publish migration. |
| Emit on every finalize where interest > 0, or only when paid out? | Every finalize where interest > 0. Even when interest is fully absorbed by deductions (interest_paid_to_tenant == 0), the audit trail should record what happened to it. event_data tells the whole story. |
| Pre-S193 thresholds — fix the principal-vs-pool semantic? | Yes. Pre-S193 threshold used `tenantPool` which created a subtle wrong classification when interest was non-zero (e.g., $1000 principal returned + $5 interest = "deposit_returned_full" was misleading). Post-S193 uses `principalRefunded`. Behavioral change is small (only matters when interest > 0) but the audit semantic is now correct. |
| Record state_code + rate at lease end on the new event? | Yes. State rate may change mid-tenancy (landlord moves to a state with different statute, or annual catalog refresh updates the rate). Recording the rate that was active at the LAST accrual gives a reproducible audit trail; the per-month accrual log has the full history. |
| Look up via `securityDeposits.id` vs subquery in event emit? | Subquery — keeps the event-emit logic self-contained in one INSERT. The accrual lookup is one SELECT on an indexed column; not hot path. |

## Discovery — `properties.deposit_interest_rate_annual` columns

While reconning, noticed `properties` has three pre-existing
columns: `deposit_interest_rate_annual numeric`,
`deposit_interest_accrual_method text` (CHECK: simple|compound),
`deposit_interest_payment_cadence text`. These look like an
earlier per-property interest-rate mechanism that predates the
S188 hardcoded catalog + S190 landlord override design.

No code references them (zero greps in routes / services /
jobs). Likely scaffolding from an early design that got
superseded. Not touching this session — would need separate
audit + Nic confirm before deciding to drop. Adding to
carry-forward for future cleanup pass.

## Carry-forward — what S194+ should target

### Specific to A3 thread

- **`properties.deposit_interest_rate_annual` columns** — appear
  superseded by the S188/S190 catalog + override design. Audit
  and propose drop. Quarter-session.
- **Tenant-facing override visibility at lease signing** (S190 carry).
  When a tenant signs a lease in a variable-rate state, surface
  the current rate they'll accrue at. Half-session.
- **Expand state catalog** — research-heavy, multi-hour task. Add
  CA / RI / IA / NH (statutory) / etc.
- **Annual rate refresh discipline** — CLAUDE.md or DEPOSIT_INTEREST_PLAYBOOK
  addendum so future-Claude knows to add 2027 rows in
  Nov/Dec. 15-min task.

### Already-known carry-forward (unchanged)

- `leases.security_deposit` → `lease_fees` deprecation (2-session,
  recon confirmed)
- B3 thread: needs-ack filter, SchedulePage tile badge, hard-gate
  check-in product call
- Primary manager urgency tier (S185 question)
- Owner-financial-escalation pattern (S186 question)
- Other POS tables for property scoping (S192 carry)
- Sublease subsystem (multi-session)
- B1+B2 material-change workflow (multi-session — needs full
  addendum + tenant-notice flow, not just confirm modal)
- C1 50-state property tax form catalog (multi-session)
- D2 Flex tenant suite (launch-flag gated)
- POS Terminal hardware + EOD
- CSV imports
- E2 npm upgrades
- F1 Marketing rebuild

---

End of S193 handoff.
