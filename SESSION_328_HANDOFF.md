# Session 328 — closed

## Theme

Continued the long-tail S312-class read audit. Targeted
the three heaviest-snake_case-count remaining pages
flagged in S327: landlord OtpPage (26), landlord
ApplicantPoolPage (31), admin main.tsx (23). Recon
revealed admin main.tsx's count was all enum-value map
keys (intentional, like TenantScreeningPage in S327);
the two landlord pages had real S312-class broken
reads. Both migrated.

## Items shipped

### Landlord `OtpPage.tsx`

Two type defs rewritten — `Tenant` (7 fields) and
`Advance` (13 fields). All read sites updated. The OTP
landlord page had been showing broken eligibility +
advance ledger rows post-S312 — tenant names blank,
cycle months / amounts / dates all undefined.

`BLOCKER_LABEL` map left as snake_case (matching the
backend's `qualification.blockers[]` string values:
`ach_unverified`, `deposit_not_funded`,
`flex_deposit_active`, `bg_check_not_approved`,
`nsf_cooldown`, `tenant_not_found`).

### Landlord `ApplicantPoolPage.tsx`

Three type defs rewritten — `PoolEntry` (9 fields),
`MatchRequest` (16 fields), `UnitOption` (3 fields). All
read sites updated. The applicant pool browser had been
showing broken match-request rows post-S312 (tenant
names, request timestamps, income/risk all undefined).

`RISK_BADGE` map left as snake_case (`very_high` is the
risk-level enum value).

### Admin `main.tsx` — no migration needed

23 snake_case "fields" all turned out to be:
- credit-event enum-value keys in EVENT_LABEL-style
  maps (`payment_received_on_time`, `lease_violation_cured`,
  etc.)
- JSONB content keys (`dispute_corrected`, `dispute_id`
  — these go inside event_data, S325 preserved as
  passthrough)
- Status enum strings (`pending_invite`)

The actual interfaces (`AdminSubleaseRow`,
`PendingTransferRow`, `CsvImportAttemptRow`,
`PlatformReviewStatus`, etc.) are all already
camelCase from prior sessions.

## Files touched (S328)

```
apps/landlord/src/pages/
  OtpPage.tsx                              (Tenant + Advance types +
                                            ~14 read sites)
  ApplicantPoolPage.tsx                    (PoolEntry + MatchRequest +
                                            UnitOption types +
                                            ~22 read sites)

SESSION_328_HANDOFF.md                     (this file)
```

No migrations. No schema changes. No backend changes. No
other portal changes.

## Decisions made during build

| Question | Decision |
|---|---|
| admin main.tsx 23 fields — migrate? | **No.** Same shape as S327's TenantScreeningPage discovery: nearly all are credit-event-type enum-value keys in label maps, JSONB content keys, or status enum strings. The actual interfaces in admin main.tsx are already camelCase. False positive from the heuristic snake_case-fields scan. |
| OtpPage `BLOCKER_LABEL` keys — touch? | **No.** Backend `qualification.blockers[]` returns string values like `'ach_unverified'`, `'flex_deposit_active'`, etc. The label map keys must match those values literally. |
| ApplicantPoolPage `RISK_BADGE` keys — touch? | **No.** `very_high` is the `risk_level` enum value from the screening service. |
| Sed mangling pattern recap | The two-pass approach (rename type-field declarations first, then property-access reads) continues to work cleanly. tsc catches all the omitted reads after pass 1. |

## Verification

- `npx tsc --noEmit` on `apps/api`: clean.
- `npx tsc --noEmit` on `apps/landlord`: clean.
- `npx tsc --noEmit` on `apps/tenant`: clean.
- `npx tsc --noEmit` on `apps/admin`: clean.
- `npx tsc --noEmit` on `apps/pm-company`: clean.

Not browser-walked.

## Items deferred — what S329 could target

Remaining long-tail S312 read candidates (from the S327
scan), ordered by snake_case-field count after S327/S328
clean-up:

- **Landlord FlexChargePage** — 17 fields
- **Landlord PmInvitationsPage** — 16 (partially done in
  S321; some type defs remain)
- **Landlord LeaseFormModal** — 20 (partially done in
  S320; rest of the file)
- **Landlord InspectionsPage** — already migrated S318
  (heuristic may be flagging enum keys)
- **Landlord PropertyDetailPage** — 6 (heuristic may
  include enum keys)
- **Landlord NotificationPrefsPage** — 5
- **Landlord EntryRequestsPage** — 10 (touched S324 detail
  page; list page may still have reads)
- **Tenant PosCustomerOnboardingPage** — 6

Most are small. Single follow-up session could clear all.

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
- Remaining long-tail S312-class reads (~7 pages, most
  small).

## Nic-pending (unchanged)

- Stripe live keys.
- Resend domain verification.
- Plaid production keys.
- Stripe Terminal hardware.
- Checkr Partner credentials.
- Consumer-side retention framing decision (S300).
- FlexCredit Lender partner selection.
- SLA § 9.1.4(iii) deposit-return offset framing call.

## What S329 should target

Next sweep of remaining S312-class pages — single
session likely clears the lot since most are small.
FlexChargePage + PmInvitationsPage + LeaseFormModal +
EntryRequestsPage + smaller stragglers.

---

End of S328 handoff. Closed clean. OtpPage +
ApplicantPoolPage migrated; admin main.tsx confirmed
already-camelCase.
