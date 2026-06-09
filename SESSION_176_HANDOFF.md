# Session 176 — closed

## Theme

Close the PM-company branch of the S175 Connect-payout
notification work + clean up the last two zero-caller helpers
flagged in the S174 audit. After this session every active
money-movement event in GAM has a recipient-side notification
wired, and the `services/notifications.ts` orphan list is empty
(or one entry, see below) — coverage is fully audited and
complete or deliberately deferred.

## What S176 shipped

### Backend — `notifyPmCompanyPayoutPaid` + `notifyPmCompanyPayoutFailed`

In `apps/api/src/services/notifications.ts`. Same shape as the
S175 user variants, but takes a `pmCompanyId` + `pmCompanyName`
instead of a single user, and fans out internally:

```ts
notifyPmCompanyPayoutPaid({
  pmCompanyId, pmCompanyName, amount, arrivalDate, stripePayoutId
})
notifyPmCompanyPayoutFailed({
  pmCompanyId, pmCompanyName, amount, reason, failureCode?, stripePayoutId
})
```

Recipient routing:
```sql
SELECT u.id, u.email, u.phone
  FROM pm_staff ps
  JOIN users u ON u.id = ps.user_id
 WHERE ps.pm_company_id = $1
   AND ps.status = 'active'
   AND ps.role IN ('owner', 'manager')
```

Generic `staff` role excluded by design. The `pm_staff_role_check`
constraint allows `owner | manager | staff` — owner and manager
are the financial-authority tier (per the schema's natural
gradient — the same split routeMaintenanceNotification's pm_staff
fan-out uses, except looser there since "respond to a maint
emergency" is an operational concern that any active staff
member could handle). For payouts, restricting to
financial-authority roles avoids spamming line-level operators
with money-movement alerts that aren't theirs to act on.

Each recipient gets an in-app + email entry; SMS fires on failure
only (urgent), not on success.

### Backend — `recordPayoutEvent` now routes both branches

In `apps/api/src/services/stripeConnect.ts`, the post-upsert
notification dispatch now handles both `userRow` and `pmRow`
matches. Same try/catch wrapper as before — Stripe webhook
must not fail on a notification problem.

```ts
if ((userRow || pmRow) && (status === 'paid' || status === 'failed')) {
  if (userRow) { /* user variant */ }
  else if (pmRow) {
    const co = await queryOne(`SELECT name FROM pm_companies WHERE id = $1`, [pmRow.id])
    if (co) { /* pm-company variant */ }
  }
}
```

PM company name is a separate query because `recordPayoutEvent`
only resolved the company id — surfacing the name in the email
subject + body is the whole point of the variant.

### Cleanup — `notifyLandlordRenewalDecision` deleted

The companion to `notifyLeaseRenewalSurvey` (deleted in S68 per
the inline comment). It was supposed to fire when a tenant
responded to the survey. With the survey retired and the S18
auto-renew model in place, there's no live trigger and no
callers. Clean removal. The S68 deletion comment was extended to
note the S176 follow-on so future-Claude doesn't try to revive
the helper without revisiting the underlying survey decision.

### Cleanup — `notifyWorkTradeHours` left intact (recon decision)

Helper exists with a coherent shape (tenant-side reminder when
work_trade_periods has hours_committed > hours_worked and
daysLeft is small). The work-trade subsystem schema is fully
built (S88 tables: `work_trade_agreements`, `work_trade_logs`,
`work_trade_periods`) but the scheduler has no entry that would
fire reminders. Use case is real — wiring is a clean future
enhancement, not a launch blocker. Leaving the helper in place;
flagged as carry-forward.

### Files touched (S176)

```
apps/api/src/services/notifications.ts                                  (+ notifyPmCompanyPayoutPaid + notifyPmCompanyPayoutFailed; − notifyLandlordRenewalDecision; comment refresh)
apps/api/src/services/stripeConnect.ts                                  (+ pm_company branch in recordPayoutEvent notify dispatch)
```

### Verification

- `cd apps/api && npx tsc --noEmit` exit 0
- Both new helpers have a single call site each in
  `stripeConnect.ts` (pm-company paid + failed branches).
- `pm_staff_role_check` constraint confirmed via
  `apps/api/src/db/schema.sql` — `owner | manager | staff` are
  the only legal values; my filter matches the constraint
  vocabulary.

## Decisions made (S176)

| Question | Decision |
|---|---|
| Which pm_staff roles get the payout notification? | `owner` + `manager`, not `staff`. Owner is unambiguous financial authority; manager typically holds finance-adjacent responsibility in PM cos. Plain `staff` is operational — payouts aren't actionable for them. routeMaintenanceNotification fans out to all-active because maintenance emergencies are operational; payouts are different. |
| Single fan-out helper that takes a recipient list, vs the per-event helpers? | Per-event. Two reasons: (a) the email/SMS copy varies — "$X is on its way to YOUR bank" reads wrong if YOU are line-level staff seeing a company payout; rewrote the body to "$X is on its way to your bank" for users vs "the company's Stripe payout of $X is on its way to your bank" for pm_staff. (b) The recipient query is the same SQL each time — collocating it with the helper that uses it is more legible than passing a recipient list. |
| Wire `notifyWorkTradeHours` while we're here? | No. The hook would be a scheduler entry, not a route call — different shape of work, and work-trade is not currently launch-blocking per CLAUDE.md. Documenting in carry-forward. |
| Delete `notifyLandlordRenewalDecision`? | Yes. Companion to the explicitly-deleted `notifyLeaseRenewalSurvey` (S68). With the survey gone, the helper has no trigger. Comment updated to extend the S68 deletion record. |

## Notification coverage — final state (S174 → S176)

After this session sweep, every money-movement event in GAM has
a recipient-side notification wired, and the orphan list is down
to one entry that's deferred-not-dead:

| Event | Helper | Status |
|---|---|---|
| Rent payment settled | `notifyRentCollected` | ✓ wired (S174) |
| Rent payment ACH-retry scheduled | `notifyAchRetryScheduled` | ✓ wired (S125) |
| Rent payment ACH-retries exhausted | `notifyAchRetriesExhausted` | ✓ wired (S125) |
| Tenant accepted invite | `notifyTenantInviteAccepted` | ✓ wired (S174) |
| Connect payout paid (user) | `notifyConnectPayoutPaid` | ✓ wired (S175) |
| Connect payout failed (user) | `notifyConnectPayoutFailed` | ✓ wired (S175) |
| Connect payout paid (pm_company) | `notifyPmCompanyPayoutPaid` | ✓ wired (S176) |
| Connect payout failed (pm_company) | `notifyPmCompanyPayoutFailed` | ✓ wired (S176) |
| Manager direct-deposit toggled on | inline | ✓ wired (S168) |
| Work-trade hours reminder | `notifyWorkTradeHours` | deferred — needs scheduler entry; helper preserved |
| Utility bill settled | _none_ | deferred deliberately (S174 — too noisy per-bill) |
| Connect payout canceled | _none_ | deferred — rare GAM-initiated state (S175) |

Pruned during this audit (S175 + S176): `notifyRentFailed`,
`notifyMaintenanceSubmitted`, `notifyDisbursementSent`,
`notifyLandlordRenewalDecision` — total 4 dead helpers removed.

## Carry-forward — what S177 should target

### Wire `notifyWorkTradeHours` from a scheduler entry

Add a daily cron to `apps/api/src/jobs/scheduler.ts` that:
- Queries `work_trade_periods` rows with `period_status='open'`
- Computes `hours_short = hours_committed - hours_worked`
- For each open period with `hours_short > 0` AND
  `daysLeft <= some_threshold` (probably 7), call
  `notifyWorkTradeHours` against the period's tenant.
- Idempotency: dedupe within the daily window via a "last_reminded_at"
  column on work_trade_periods (would need a small migration) so the
  same tenant doesn't get hit every day.

Estimated half-session.

### Tenant rent + utility smoke walk (manual)

Still blocked on Stripe sandbox creds. End-to-end validation of
S169–S172 work plus the new S174–S176 notification pings.

### Already-known carry-forward (still open, unchanged)

- `lease_fees.due_timing` `move_out` / `other` wiring (blocked
  on Nic product call).
- Per-state tax form catalog (DEFERRED Item 3 — needs Nic input).
- Property-detail page fee chips (S173 follow-on).
- Strip mock `AchVerifyForm` once OTP greenlit.
- `apps/admin/src/main.tsx` split (~1700 lines mechanical).
- Stripe-Custom-controller migration (product call).
- 4 of 8 npm audit root-vuln packages need breaking upgrades.

---

End of S176 handoff.
