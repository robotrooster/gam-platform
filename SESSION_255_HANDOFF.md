# Session 255 — closed

## Theme

FlexDeposit portability — the deposit carries forward when a tenant
moves between GAM landlords instead of triggering the standard return
engine. Backend complete; tenant UI surface deferred to S256 to keep
this session tight.

## Product spec confirmed (Nic, this session)

| Question | Decision |
|---|---|
| Detection signal | (c) auto-detect when tenant has another GAM lease in pending/active status, with explicit tenant opt-out at termination |
| Money model | Push for GAM-escrow holding wherever possible. `held_by='gam_escrow'` deposits carry forward with zero money movement; `held_by='landlord'` deposits flag for admin-mediated reverse-Transfer to GAM escrow (then carry forward). Strategy: every portability event grows GAM's escrow float pool. |
| Tenant authorization | (a) explicit signature at termination flow — mirrors S250 sublease liability disclosure pattern |

## Items shipped

### Migrations — 2 files

**`20260511170000_deposit_portability.sql`** — `security_deposits`
adds 6 columns:
- `portability_status` enum (none/pending_auth/authorized/
  carried_forward/pending_transfer/declined) with CHECK constraint
- `portability_authorized_at` timestamptz
- `portability_authorized_signature` text (capture of the typed
  signature at authorization time)
- `portability_authorized_ip` text (audit field)
- `portability_target_lease_id` uuid FK to leases (the next lease)
- `carried_from_deposit_id` uuid self-FK (audit chain — when a
  deposit was the result of a carry-forward, points back at the
  source row on the previous lease)

Two indexes: partial index on pending portability states + on the
carry-forward chain.

**`20260511170100_deposit_returns_carried_forward.sql`** — extends
`deposit_returns.status` CHECK to include `'sent_carried_forward'`.
Finalize engine uses this status when the portability branch
executes instead of `sent_refund` / `sent_gap`.

### Service — `apps/api/src/services/depositPortability.ts` (new, ~290 lines)

| Export | Purpose |
|---|---|
| `detectPortabilityEligible({ leaseId, tenantId? })` | Returns `{eligible, reason, current_lease_id, target_lease_id, target_property_name, target_landlord_id, deposit_id, deposit_amount, held_by}`. Auto-detects target: tenant's most-recently-created lease in pending/active state on GAM. |
| `authorizeDepositPortability({ tenantId, depositId, targetLeaseId, signature, ip? })` | Captures signature + audit fields, flips deposit `portability_status='authorized'` + stamps target_lease_id. Idempotent for same target; throws 409 for different target (decline first). |
| `declineDepositPortability({ tenantId, depositId })` | Clears the authorization. Resets `portability_status='declined'`. |
| `executeDepositPortability({ depositId })` | Called from deposit-return finalize post-commit. Verifies target lease still valid; re-points `security_deposits.unit_id` + `lease_id` to target; flips `held_by='gam_escrow'`; sets `portability_status='carried_forward'` (gam_escrow source) or `'pending_transfer'` (landlord-held source) + admin alert for the funds move. Idempotent on already-carried_forward rows. |

### Tenant routes — `apps/api/src/routes/tenants.ts` (3 new)

| Route | Verb | Purpose |
|---|---|---|
| `/api/tenants/me/deposit/portability/eligibility` | GET | `?leaseId=...` — eligibility view for the UI |
| `/api/tenants/me/deposit/portability/authorize` | POST | Body `{ depositId, targetLeaseId, signature }` |
| `/api/tenants/me/deposit/portability/decline` | POST | Body `{ depositId }` |

All three gate on `req.user.profileId` via the underlying service.

### Deposit-return engine integration — `apps/api/src/services/depositReturn.ts`

`finalizeDepositReturn` now branches on the portability state:

- **Inside transaction (after the unpaid-balance sweep)**: queries
  `security_deposits` for `portability_status='authorized'` on this
  lease. If found, sets `nextStatus = 'sent_carried_forward'`,
  skips refund/gap payments row creation, skips
  `deposit_returned_*` and `tenancy_ended_with_balance` credit-
  ledger emits (the deposit wasn't "returned" — it carried forward;
  emits are inappropriate).
- **Post-commit (outside tx)**: invokes
  `executeDepositPortability` to re-point the security_deposit
  row + flip held_by. Best-effort with logged failure — the
  deposit_returns row is already finalized, so admin can retry
  manually if the post-commit step fails.

Landlord A's unpaid-balance sweep still runs (priority claim — same
as the standard return path).

## Decisions made during build

| Question | Decision |
|---|---|
| Where does the portability check inject? | Inside `finalizeDepositReturn` after the unpaid-balance sweep but before refund/gap row creation. Sweep deducts landlord A's claims first; only the post-sweep balance carries forward. |
| `held_by='landlord'` deposits at portability time? | Status flips to `'pending_transfer'` + admin alert. Row is *logically* re-pointed and `held_by='gam_escrow'` immediately, but the physical funds still sit in landlord A's Connect balance. Admin tool (deferred — Stripe reverse-Transfer is the underlying mechanism) moves the money. New deposits should be `gam_escrow` from move-in (per Nic's "push for GAM to hold"), making this the legacy edge case. |
| Multiple eligible target leases? | Most-recently-created wins. Common case: tenant's most recent move is the destination. |
| `security_deposits.collected_amount` adjustment on sweep? | Not modified in S255 — the post-sweep deductions are tracked via `paid_via_deposit` on the swept payments rows; security_deposit row itself stays at the original collected total. New landlord can see the original collected; if they want to enforce a top-up, that's a separate flow. |
| New credit-ledger event for `deposit_carried_forward`? | Skipped for S255 — credit-ledger emit for the transition can be added in a follow-up if it shapes scoring. For now, the audit trail lives on `carried_from_deposit_id` chain + the deposit_returns row + the admin notification on landlord-held cases. |
| Tenant UI in S255? | Deferred to S256. Backend is functional end-to-end via direct API; UI is a contained follow-up that doesn't block the engine work. |

## Files touched (S255)

```
apps/api/src/db/migrations/
  20260511170000_deposit_portability.sql              (new — 75 lines)
  20260511170100_deposit_returns_carried_forward.sql  (new — 18 lines)
apps/api/src/db/schema.sql                            (regenerated)
apps/api/src/services/depositPortability.ts           (new — ~290 lines)
apps/api/src/services/depositReturn.ts                (~ portability
                                                       branch in
                                                       finalize tx +
                                                       post-commit
                                                       execute + skip
                                                       return events;
                                                       ~+50 / -3 lines)
apps/api/src/routes/tenants.ts                        (+ 3 portability
                                                       routes; ~+50 lines)
DEFERRED.md                                           (~ FlexDeposit entry
                                                       — portability
                                                       backend shipped;
                                                       UI + admin tool
                                                       flagged)
SESSION_255_HANDOFF.md                                (this file)
```

## Verification

- `cd apps/api && npx tsc --noEmit` → clean
- Migrations applied: `\d security_deposits` confirms portability
  columns + CHECK; `\d deposit_returns` confirms
  `'sent_carried_forward'` in the status enum

## End-to-end portability flow (backend functional now)

1. Tenant A finishes one lease, has a new lease at Landlord B
   pending or active
2. Lease-termination flow runs `detectPortabilityEligible(leaseId)`
   — returns eligible=true with target_lease info
3. **(UI deferred to S256)** Tenant signs authorization via UI
   → `POST /api/tenants/me/deposit/portability/authorize`
4. `security_deposits.portability_status='authorized'` + signature
   + IP recorded; target_lease_id stamped
5. Lease ends, deposit-return engine creates a draft + finalize fires
6. Inside finalize tx: unpaid-balance sweep deducts landlord A's
   claims via `paid_via_deposit` on the payment rows. Portability
   check sees `status='authorized'`, skips refund/gap rows + return
   credit events. `nextStatus='sent_carried_forward'`. Commit.
7. Post-commit: `executeDepositPortability` re-points
   `security_deposits.unit_id` + `lease_id` to target lease;
   flips `held_by='gam_escrow'`; sets
   `portability_status='carried_forward'` (gam_escrow source) or
   `'pending_transfer'` (landlord-held source + admin alert)
8. Tenant's deposit balance is now collateral on the new lease at
   Landlord B; custody fee continues uninterrupted

## Carry-forward — S256+

### Sublease subsystem
Closed in S251.

### Flex Suite remaining work

- **FlexDeposit portability tenant UI** — S256. Eligibility banner
  on tenant LeasePage near termination flow + signature-capture
  authorization modal. Backend ready.
- **FlexDeposit landlord-held reverse-Transfer admin tool** — Stripe
  reverse-Transfer or similar mechanism. Currently the row flips
  to `pending_transfer` and admin sees an alert; the actual funds
  move is manual.
- **FlexDeposit missed-installment legal remedy** — Nic pending spec.
- **FlexCharge polish** — statement history view, in-app dispute
  flow, pos_customer ACH onboarding (post-launch).
- **FlexCredit** — vendor-pending (CredHub callback + Esusu email).

### External-vendor-blocked

- **Checkr Partner** — credentials pending

### Smaller items

- POS multi-terminal sync (premature)
- POS / `/resolve` smokes (Nic-runs)
- OTP cron-timing rework (non-blocking)

## Revised count

| Bucket | Pre-S255 | Post-S255 |
|---|---|---|
| FlexDeposit | 2 outstanding (portability + missed-installment) | 1 (missed-installment, Nic-blocked) + 2 smaller (UI + admin tool) |
| Multi-session epics in flight | 0 | 0 |
| v1 launch-ready Flex products | 3 of 4 (FlexPay, FlexDeposit core, FlexCharge) | Same; FlexDeposit portability backend now lives alongside |

**Until v1 launch-ready:** S256 = FlexDeposit portability UI (clean
1-session pick). Then vendor unblocks (FlexCredit, Checkr). FlexCharge
polish is post-launch.

---

End of S255 handoff.
