# Session 175 — closed

## Theme

Close the third real notification gap surfaced in S174 — Stripe
Connect payout settlements now notify the recipient. Plus prune
the three truly-dead `notify*` helpers identified in the S174
recon audit. Net: every active money-movement event in GAM now
fires a landlord-side notification, and the
`services/notifications.ts` orphan list is empty.

## What S175 shipped

### Backend — new helpers `notifyConnectPayoutPaid` + `notifyConnectPayoutFailed`

In `apps/api/src/services/notifications.ts`. Replace the dead
`notifyDisbursementSent` (which had the wrong shape for S113 era
— `period: string` + `unitCount: number` reflected the pre-S113
batched GAM-rail model that no longer exists). The new pair is
shaped for individual Stripe Connect payouts:

```ts
notifyConnectPayoutPaid({
  userId, userEmail, userPhone?, amount, arrivalDate, stripePayoutId
})
notifyConnectPayoutFailed({
  userId, userEmail, userPhone?, amount, reason, failureCode?, stripePayoutId
})
```

Notification types `connect_payout_paid` / `connect_payout_failed`
flow through `createNotification` → email + (in-app) +
`notification_preferences` gating. Email body links the user back
to the Banking page. SMS sent on failure (urgent), suppressed on
success (informational).

### Backend — `recordPayoutEvent` now notifies on terminal status

In `apps/api/src/services/stripeConnect.ts`, after the
`connect_payouts` upsert + `disbursements`-status mirror, fire
the appropriate notify helper when:
- `status === 'paid'`  → `notifyConnectPayoutPaid` (informational)
- `status === 'failed'` → `notifyConnectPayoutFailed` (urgent)

Only for `userRow` payouts (landlord / opt-in manager). PM
company payouts are skipped here — they need separate routing
through `pm_staff` (the company entity has no email/phone of its
own; notifications have to fan out to active staff with
appropriate permissions). Tracked as carry-forward.

Failures caught + logged. The webhook must not fail on a
notification problem because Stripe would retry the whole event
and re-write the `connect_payouts` row.

### Cleanup — three dead helpers removed

Per the S174 audit, three `notify*` exports had zero callers AND
were superseded by other code paths. All deleted from
`apps/api/src/services/notifications.ts`:

| Helper | Replaced by |
|---|---|
| `notifyRentFailed` | `notifyAchRetryScheduled` / `notifyAchRetriesExhausted` (S125 retry-aware webhook handler covers all failure modes — both ACH-retry-eligible and immediate-card-fail land in the appropriate path) |
| `notifyMaintenanceSubmitted` | `routeMaintenanceNotification` (routing-aware emergency / approval-required / submitted dispatcher used by the maintenance route) |
| `notifyDisbursementSent` | `notifyConnectPayoutPaid` (this session — correct shape for S113 destination charges) |

The stale "Distinct from notifyRentFailed which assumes terminal
failure" comment on `notifyAchRetryScheduled` was also refreshed
to reference `notifyAchRetriesExhausted` instead.

### Files touched (S175)

```
apps/api/src/services/notifications.ts                                  (− notifyRentFailed, notifyMaintenanceSubmitted, notifyDisbursementSent; + notifyConnectPayoutPaid, notifyConnectPayoutFailed; comment refresh)
apps/api/src/services/stripeConnect.ts                                  (+ post-upsert notify dispatch in recordPayoutEvent for status='paid' / 'failed')
```

### Verification

- `cd apps/api && npx tsc --noEmit` exit 0
- Both new helpers have a single call site in `stripeConnect.ts`
  (paid + failed branches).
- Confirmed via grep that the three deleted helper names appear
  only in one comment (`services/notifications.ts:199`) — the
  doc comment on the new helpers explaining what they replace.

## Decisions made (S175)

| Question | Decision |
|---|---|
| One generic `notifyConnectPayout(o)` with status discriminator, or separate paid/failed helpers? | Separate. Different copy, different urgency (paid is informational; failed is alert-tier with SMS), different parameter shape (`reason` only on failed). Splitting matches the rest of the file's pattern. |
| Notify on `pending` / `in_transit`? | No. Those are intermediate states; the payout hasn't reached the bank yet and won't for hours. Notifying twice (in-flight + paid) would be noise. Final-status only. |
| Notify on `canceled`? | Skipped this session. Cancels are rare and usually GAM-initiated (e.g., admin reversal); the user/landlord is already in the loop via the action that triggered the cancel. Add later if a real flow surfaces. |
| PM company payout notifications? | Deferred. PM companies have no `users.email/phone` directly — needs a fan-out to active `pm_staff` rows with a notification-eligible permission. Designable but its own scope. |
| Delete the dead helpers in the same session? | Yes. Three cleanly-replaced helpers, zero callers, no risk. Pruning them while we're already in `notifications.ts` writing the replacement is the right time. |
| Keep `notifyWorkTradeHours` and `notifyLandlordRenewalDecision`? | Yes — left alone. Both are zero-caller but the scope/intent is unclear from name alone, and unlike the three pruned helpers there's no obvious replacement code path that would mark them as superseded. Future session should investigate. |

## Notification coverage — current state

After S174 + S175, the in-platform notification coverage for
money-movement events is:

| Event | Helper | Caller | Status |
|---|---|---|---|
| Rent payment settled | `notifyRentCollected` | `webhooks.ts` payment_intent.succeeded | ✓ wired (S174) |
| Rent payment ACH-retry scheduled | `notifyAchRetryScheduled` | `webhooks.ts` payment_intent.payment_failed | ✓ wired (S125) |
| Rent payment ACH-retries exhausted | `notifyAchRetriesExhausted` | `webhooks.ts` payment_intent.payment_failed | ✓ wired (S125) |
| Tenant accepted invite | `notifyTenantInviteAccepted` | `tenants.ts` accept-invite | ✓ wired (S174) |
| Connect payout paid | `notifyConnectPayoutPaid` | `stripeConnect.ts` recordPayoutEvent | ✓ wired (S175) |
| Connect payout failed | `notifyConnectPayoutFailed` | `stripeConnect.ts` recordPayoutEvent | ✓ wired (S175) |
| Manager direct-deposit toggled on | `manager_direct_deposit_enabled` (inline) | `scopes.ts` PATCH direct-deposit | ✓ wired (S168) |
| Utility bill settled | _none_ | _none_ | deferred — utilities are smaller / more frequent (S174 decision) |
| PM company Connect payout | _none_ | _none_ | deferred — needs `pm_staff` fan-out routing (S175) |
| Connect payout canceled | _none_ | _none_ | deferred — rare GAM-initiated state (S175) |

## Carry-forward — what S176 should target

### PM company payout notification fan-out

The skipped path from this session — `recordPayoutEvent` returns
silently when the matched Connect entity is a `pm_companies` row,
not a user. PM companies have no inherent email/phone; the
notification needs to fan out to active `pm_staff` rows whose
role grants payout visibility (probably `owner` or
`finance_admin` — needs a check against the existing
`pm_staff_role_check` constraint). New helper
`notifyPmCompanyPayoutPaid` / `Failed` that takes a
`pmCompanyId` and resolves staff internally.

Estimated 1 session.

### `notifyWorkTradeHours` and `notifyLandlordRenewalDecision` recon

Both are zero-caller. Names suggest they belong in (a) the
work-trade subsystem (S88 — `work_trade_logs` /
`work_trade_periods`) and (b) the lease renewal flow (S168 era).
Recon to determine if they're orphaned-but-needed (real launch
gap) or orphaned-because-superseded (delete candidate).

### Already-known carry-forward (still open, unchanged)

- Utility-bill settled notification (`notifyUtilityCollected`)
  — deferred deliberately as noisy; revisit if Nic wants it.
- Tenant rent + utility smoke walk (manual, blocked on Stripe
  sandbox creds).
- `lease_fees.due_timing` `move_out` / `other` wiring (blocked
  on Nic product call).
- Per-state tax form catalog (DEFERRED Item 3 — needs Nic input).
- Property-detail page fee chips (S173 follow-on).
- Strip mock `AchVerifyForm` once OTP greenlit.
- `apps/admin/src/main.tsx` split (~1700 lines mechanical).
- Stripe-Custom-controller migration (product call).
- 4 of 8 npm audit root-vuln packages need breaking upgrades.

---

End of S175 handoff.
