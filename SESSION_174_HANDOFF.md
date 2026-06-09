# Session 174 — closed

## Theme

Wire the missing landlord-facing notifications. Real launch UX gaps
surfaced by recon: two `notify*` helpers existed in
`services/notifications.ts` but had zero callers anywhere — meaning
landlords got no email, no SMS, no in-app entry when (a) a tenant's
rent payment settled, or (b) an invited tenant accepted and
activated their account. Both flows shipped this session.

## What S174 shipped

### Recon — orphan notification helpers

Audited every `notify*` export in `services/notifications.ts` for
call sites across the API. Result:

| Helper | Callers | Status |
|---|---|---|
| `notifyRentCollected` | 0 → 1 (S174) | **WIRED** |
| `notifyTenantInviteAccepted` | 0 → 1 (S174) | **WIRED** |
| `notifyRentFailed` | 0 | dead — replaced by `notifyAchRetryScheduled` / `notifyAchRetriesExhausted` (S125 webhook handler) |
| `notifyMaintenanceSubmitted` | 0 | dead — replaced by `routeMaintenanceNotification` (routing-aware emergency / approval / submitted dispatcher) |
| `notifyDisbursementSent` | 0 | wrong shape — designed for pre-S113 batched GAM-rail disbursements (`period`, `unitCount`); under destination charges + Stripe Connect each payout fires individually with no batch context. Needs a new `notifyConnectPayoutPaid` shape to wire from `recordPayoutEvent` |
| `notifyWorkTradeHours` | 0 | scope unclear — leave alone for now |
| `notifyLandlordRenewalDecision` | 0 | scope unclear — leave alone for now |
| All other `notify*` | ≥2 each | wired |

### Backend — `payment_intent.succeeded` webhook now notifies

In `apps/api/src/routes/webhooks.ts`, after the settlement
transaction commits and the PM/manager Transfer firing completes:

```ts
for (const row of settledRows) {
  if (row.type !== 'rent') continue
  // ... lookup tenant_name + unit_number + property_name +
  //     landlord email/phone via JOIN ...
  await notifyRentCollected({ landlordUserId, landlordId,
    landlordEmail, landlordPhone, tenantName, unitNumber,
    propertyName, amount })
}
```

Skips utility rows — utilities are smaller, more frequent, and a
per-utility-bill ping would be noisy. Notifies only on the more
significant rent settle. (Add `notifyUtilityCollected` later if
Nic asks; the settled-rows loop is structured to make that a
one-line addition.)

Failure-mode: notification errors are caught + logged; they do
not propagate. Stripe would otherwise retry the entire webhook
which would re-allocate. The credit-ledger event emitted inside
the settlement transaction remains the durable record.

### Backend — `POST /api/tenants/accept-invite` now notifies

In `apps/api/src/routes/tenants.ts`, after the tenant's password
is hashed and `email_verified` flips TRUE:

```ts
// Resolve landlord via tenant's active lease + emit notification
const ctx = await queryOne(/* JOIN through v_lease_active_tenants
   → leases → units → properties → landlords → users */)
if (ctx) {
  await notifyTenantInviteAccepted({
    landlordUserId, landlordId, landlordEmail,
    tenantName, tenantEmail, unitNumber, propertyName,
  })
}
```

Best-effort — wrapped in try/catch outside the activation flow.
If the tenant has no active lease yet (rare edge — invitations
typically fire from a lease build) the notify is skipped silently.

The notification type `tenant_invite_accepted` flows through the
standard `createNotification` path which respects the landlord's
`notification_preferences` row for that type (defaults: email on,
SMS off, in-app on).

### Files touched (S174)

```
apps/api/src/routes/webhooks.ts                                         (+ rent-collected notify loop in payment_intent.succeeded post-commit)
apps/api/src/routes/tenants.ts                                          (+ tenant-invite-accepted notify in accept-invite handler)
```

### Verification

- `cd apps/api && npx tsc --noEmit` exit 0
- Both helpers now have a single call site each, replacing zero.
- `createNotification` (the underlying transport) was already
  wired to email + SMS + in-app + `notification_preferences`
  gating per S106; no notification-system changes needed.

## Decisions made (S174)

| Question | Decision |
|---|---|
| Wire `notifyRentCollected` for utility too? | No, rent-only. Utility settlements are smaller and more frequent; per-bill notifications would be noise. The settled-rows loop is structured so adding `notifyUtilityCollected` is a one-line addition when product wants it. |
| Where to call notify — inside the settlement tx or post-commit? | Post-commit. Notification failures shouldn't roll back the settlement (Stripe would retry the whole thing). The credit-ledger event emitted inside the tx remains the durable record of what happened; the notify is a UX layer on top. |
| Delete dead `notifyRentFailed` / `notifyMaintenanceSubmitted` helpers? | No, not this session. They're truly dead but deletion is churn-for-churn's-sake when a future session might want them as a starting point for shape-revisions (or when they could be revived as fallback paths). Documented in the orphan table above for next-time review. |
| Wire `notifyDisbursementSent` while I'm at it? | No. Helper has the wrong shape for S113 destination charges (`period: string` + `unitCount: number` reflect the pre-S113 batched GAM-rail era). Wiring it would either misfire or require a fresh helper signature. Tracked as carry-forward. |
| Resolve landlord via active lease vs invitation row for the invite-accepted notify? | Active lease (via `v_lease_active_tenants`). The accept-invite endpoint is for tenants invited from a landlord-built lease — by the time they accept, the lease should be active. Falling back to the invitation row would add complexity for a rare edge case (invite without lease). |

## Carry-forward — what S175 should target

### Wire payout-paid landlord notification

The Stripe Connect `payout.paid` webhook calls
`recordPayoutEvent` (writes to `connect_payouts`, updates
`disbursements.status`) but doesn't notify the landlord. Closest
existing helper `notifyDisbursementSent` has the wrong shape
(pre-S113 batch context). Cleanest path: build a new
`notifyConnectPayoutPaid({ landlordUserId, landlordId,
landlordEmail, amount, arrivalDate, destinationLast4 })` and
fire it from `recordPayoutEvent` when `status === 'paid'` and
the matched user is a landlord. Mirror failure-mode notification
on `payout.failed` (status='failed').

Estimated half-session.

### Optional: prune dead notification helpers

`notifyRentFailed` and `notifyMaintenanceSubmitted` are truly
dead — replaced by `notifyAchRetryScheduled` /
`notifyAchRetriesExhausted` and `routeMaintenanceNotification`
respectively. Cleanup deletion is fine whenever a future session
naturally touches `services/notifications.ts`. ~10 lines.

### Already-known carry-forward (still open, unchanged)

- Tenant rent + utility smoke walk (manual; needs Stripe creds).
- `lease_fees.due_timing` `move_out` / `other` wiring (blocked
  on Nic product call).
- Per-state tax form catalog (DEFERRED Item 3 — needs Nic input).
- Property-detail page fee chips (S173 follow-on).
- Strip mock `AchVerifyForm` once OTP greenlit.
- `apps/admin/src/main.tsx` split (~1700 lines mechanical).
- Stripe-Custom-controller migration (product call).
- 4 of 8 npm audit root-vuln packages need breaking upgrades.

---

End of S174 handoff.
