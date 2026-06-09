# Session 327 — closed

## Theme

Long-tail S312-class read audit, scoped to launch-critical
pages. Bulk recon turned up ~280 snake_case type-field
declarations across ~15 frontend pages — too big for one
session. Scoped to three high-impact surfaces plus a
discovery that TenantScreeningPage's 51 snake_case fields
are all credit-event enum-value map keys (intentional,
not broken).

Net result: tenant PaymentsPage (deposit interest reads),
landlord NotificationsPage (inbox feed reads), tenant
LeasePage (remaining sections after S320 sublease pass)
all camelCase end-to-end. Five-portal tsc clean.

## Items shipped

### Tenant `apps/tenant/src/pages/PaymentsPage.tsx`

`DepositInterestData` type rewritten — 15 snake_case
fields across `deposit`, `rate`, and `accruals[]` shapes
renamed to camelCase. All read sites updated
(`data.deposit.totalAmount`, `data.rate.annualRatePct`,
`a.accrualMonth`, etc.). The deposit-interest card on
the tenant payments page was rendering blank values
pre-S327 since all reads returned `undefined` post-S312
interceptor.

### Landlord `apps/landlord/src/pages/NotificationsPage.tsx`

`Notification` type rewritten — `readAt`, `createdAt`,
`emailSent`, `emailSentAt`, `smsSent`, `smsSentAt`. All
JSX read sites (`n.createdAt`, `n.emailSent`,
`n.smsSent`) updated. The notification-inbox page had
been showing "Invalid Date" timestamps and broken
email/sms badges since S312 landed.

`TYPE_LABEL` map keys left as snake_case (matching
`admin_notifications.category` DB enum values like
`rent_collected`, `ach_retry_scheduled`). Inline comment
on the `data` JSONB passthrough rule.

### Tenant `apps/tenant/src/pages/LeasePage.tsx`

Remaining sections post-S320 sublease pass — addendum
event reads, sublessor credit payload, portability
eligibility. ~18 snake_case fields renamed across the
AddendumEvent / SublessorCreditPayload /
PortabilityEligibility types + all read sites.

### Discovery (not shipped)

**TenantScreeningPage's 51 "snake_case fields" are
credit-ledger event_type enum values.** The
`EVENT_LABEL: Record<string, string>` map at line 32
keys by `event_type` enum content (`payment_received_on_time`,
`lease_violation_cured`, etc.). Those keys MUST stay
snake_case to match the wire-level `event.eventType`
values returned by the credit-events API. False alarm
from the heuristic scan.

## Files touched (S327)

```
apps/tenant/src/pages/
  PaymentsPage.tsx                         (DepositInterestData
                                            type + ~18 read sites)
  LeasePage.tsx                            (AddendumEvent +
                                            SublessorCreditPayload +
                                            PortabilityEligibility +
                                            ~18 read sites)

apps/landlord/src/pages/
  NotificationsPage.tsx                    (Notification type +
                                            ~6 read sites)

SESSION_327_HANDOFF.md                     (this file)
```

No migrations. No schema changes. No backend changes.

## Decisions made during build

| Question | Decision |
|---|---|
| TenantScreeningPage 51 fields — migrate? | **No.** All are credit-event enum-value keys in the EVENT_LABEL map. They match `credit_events.event_type` DB content and must stay snake_case. False positive from the heuristic snake_case-fields scan. |
| Scope of S327 — all 15 candidate pages or a subset? | **Subset (3 highest-impact).** PaymentsPage, NotificationsPage, LeasePage cover the most-viewed tenant + landlord surfaces. Remaining pages (OtpPage, FlexChargePage, ApplicantPoolPage, etc.) defer to subsequent sessions. |
| `Notification.data` JSONB content keys — touch? | **No.** `data` is in the camelize passthrough set (`packages/shared/src/camelize.ts`); reading `n.data.inspection_id` / `n.data.entry_request_id` is correct. Inline comment added so future devs don't reflexively camel-case the inner keys. |
| Sed mangled `target_property_name` partially (→ `target_propertyName`)? | **Caught + fixed in retry.** sed pattern matched the field-decl form (with colon) but not the property-access form (with dot). Re-ran with `.snake_case` patterns. tsc caught the residual. |

## Verification

- `npx tsc --noEmit` on `apps/api`: clean.
- `npx tsc --noEmit` on `apps/landlord`: clean.
- `npx tsc --noEmit` on `apps/tenant`: clean.
- `npx tsc --noEmit` on `apps/admin`: clean.
- `npx tsc --noEmit` on `apps/pm-company`: clean.

Not browser-walked.

## Items deferred — what S328 could target

Remaining S312-class candidates ordered by snake_case
field count (from the S327 recon scan):

- **Landlord OtpPage** — 26 fields (on-time-pay enrollment surface)
- **Landlord LeaseFormModal** — 20 (partially done in S320; remaining type defs)
- **Landlord PmInvitationsPage** — 16 (partially done in S321; remaining type defs)
- **Landlord FlexChargePage** — 17
- **Landlord ApplicantPoolPage** — 31
- **Admin main.tsx** — 23 (admin portal type defs)
- **Landlord InspectionsPage / PropertyDetailPage** — ≤6 each
- **Landlord NotificationPrefsPage / EntryRequestsPage** — small
- **Tenant PosCustomerOnboardingPage** — 6

Plus the still-deferred:
- POS request-body migration (offline-sync care)
- SchedulePage booking-vs-lease shape audit
- Unicode-capable font in flexsuitePdf
- Acceptance subsystem test coverage

## Items deferred (cross-session docket)

- Consumer-side retention framing decision (S300).
- Campground Master import path (Nic-blocked on sample).
- 2FA fan-out.
- Yardi GL-export columns, Rentec template (S293).
- FlexCharge Business Account Agreement signature capture
  (S309 option B — not a launch feature).
- FlexDeposit eligibility-check workflow (S309 option C).
- Standalone POS-operator auth (S309 option D).
- Deposit-return ↔ unpaid-installment offset architecture
  call (S310 carryover).
- SchedulePage booking-vs-lease shape audit.
- POS request-body migration.
- Embed Unicode-capable font in flexsuitePdf.
- Acceptance subsystem test coverage.
- Remaining long-tail S312-class reads (~10 pages).

## Nic-pending (unchanged)

- Stripe live keys.
- Resend domain verification.
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.
- Consumer-side retention framing decision (S300).
- FlexCredit Lender partner selection.
- SLA § 9.1.4(iii) deposit-return offset framing call.

## What S328 should target

Next sweep of the long-tail S312 reads is the natural
continuation. Highest-impact remaining: landlord OtpPage
+ landlord ApplicantPoolPage + admin main.tsx — all
have 20+ snake_case field declarations each.

---

End of S327 handoff. Closed clean. Three more S312-class
silent-broken-read surfaces cleared.
