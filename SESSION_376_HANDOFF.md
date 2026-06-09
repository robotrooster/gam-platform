# Session 376 — closed

## Theme

tenants.ts arc continues. **Slice 3 of N:** OTP-deprecated stub
+ credit-reporting enrollment + payments history + portability
decline + re-acceptance preview (5 tenant-action routes).

The slice surfaced **1 substantive product-naming bug** (the
`credit_reporting_enrolled` column is enrolled as "rent reporting
to 3 bureaus" in tenants.ts but labeled "FlexCredit enrolled" in
admin.ts — needs Nic's call to disambiguate).

9 new test cases pin the slice.

Suite at S375 close: **1115 / 64 files**.
Suite at S376 close: **1124 / 65 files** (+9 cases, +1 file).
Runtime ~545s.

Zero tsc regressions, zero production regressions.

## Session opener

Opened with `/clear` per S375 close-note recommendation
(chain was 29 deep; clean handoff recommended). S375 had
proposed two next-session options:

1. **Checkr API wire-up** (memory: `project_checkr_access_unblocked.md`)
2. **tenants.ts OTP + credit + payments** (small slice, 3 routes)

Nic chose **tenants.ts continuation**: "we need to continue with
the tenant portal bug sweep." Checkr stays parked until next
fresh-context session.

Slice scope expanded from the S375 recommendation (3 routes →
5 routes) to also close out the two routes deliberately skipped
in slice 2: `/me/deposit/portability/decline` and `/flexsuite/
re-acceptance-preview`. Both are small pass-throughs and were
worth pinning while context was warm on the slice 2 mocks.

## Items shipped

### Test coverage — 9 cases / 5 describe blocks

New file: `apps/api/src/routes/tenants-actions.test.ts` (288 lines)

**OTP (deprecated S155) — 1 case**
- POST /enroll-on-time-pay → 410 Gone; deprecation message;
  `on_time_pay_enrolled` column NOT flipped (DB pre/post asserted)

**Credit reporting — 1 case (3 assertions)**
- POST /enroll-credit-reporting → 200; column flips FALSE→TRUE;
  re-call is idempotent (no error, column stays TRUE)

**Payments history — 2 cases**
- GET /payments empty → `{success:true, data:[]}`
- GET /payments cap-at-24 with cross-tenant isolation: seeded 26
  payments for caller across 26 distinct due_dates + 1 row for
  another tenant on a same-day date; response is exactly 24 rows,
  every row's `tenant_id` is the caller's, first row is today's
  (DESC ordering)

**Portability decline — 2 cases**
- POST /me/deposit/portability/decline missing depositId → 400
  "depositId required"; service NOT called
- Happy: calls `declineDepositPortability({tenantId, depositId})`

**Re-acceptance preview — 3 cases**
- GET /flexsuite/re-acceptance-preview invalid product → 400
  "flexpay or flexdeposit"; service NOT called
- Happy flexpay: returns `{product, version, renderedText}` with
  `version='v1.0'`; service called with tenantId + product
- Happy flexdeposit: returns FLEXDEPOSIT_TEMPLATE_VERSION

### Test infra

- Mocks for 2 service functions: `declineDepositPortability` +
  `renderReAcceptanceTerms` (vi.hoisted pattern, with the
  `FLEXPAY_TEMPLATE_VERSION` / `FLEXDEPOSIT_TEMPLATE_VERSION`
  constants stubbed in the mock)

## Files touched

```
apps/api/src/routes/
  tenants-actions.test.ts   (NEW — 288 lines, 9 cases)
```

No production code touched. No migrations. No schema changes.

## Bug found — `credit_reporting_enrolled` ↔ FlexCredit mislabel

**The bug.** A single column, `tenants.credit_reporting_enrolled`,
is the join point between two products that CLAUDE.md describes as
distinct:

- `apps/api/src/routes/tenants.ts:777` (the route that flips the
  column to TRUE) returns the message:
  `"Credit reporting enrolled — $5/month reported to all 3 bureaus"`
  — i.e. **rent-payment reporting to credit bureaus** (a furnishing
  product where GAM acts as data furnisher to Equifax / Experian /
  TransUnion).
- `apps/api/src/routes/admin.ts:36`, `:176`, `:260`, `:369` label
  the same column as **"FlexCredit"**: the KPI name is
  `flex_credit`, the onboarding-completeness checklist row reads
  "FlexCredit enrolled".

Per CLAUDE.md's FlexSuite product-line section, **FlexCredit** is
defined as:

> Third-party Lender is the creditor, GAM is a referral partner
> with a markup. Lender (identified at enrollment) handles the
> TILA / FCRA / state-licensing compliance.

i.e. FlexCredit is a **lender-referral** product. Rent reporting
to bureaus is a **data-furnishing** product. These are not the
same thing — and grouping rent reporting under the FlexCredit
label has downstream regulatory implications:

- If the admin label is correct (the column IS FlexCredit-enrollment),
  then the tenants.ts route message is wrong and is misleading
  tenants into thinking they're enrolling in a credit-furnisher
  product when they're actually being referred to a third-party
  lender. This would be a FTC §5 misrepresentation concern.
- If the route message is correct (the column IS rent-reporting
  enrollment), then GAM is acting as an FCRA furnisher — a
  regulated activity with its own compliance burden (Reg V
  furnisher rule, data accuracy obligations, dispute handling
  per §623). The admin "FlexCredit" labels are then misleading
  internally and need to be split into separate columns.

**Recommendation for Nic.** This is a product-call decision and
I won't pick one. Three plausible resolutions:

1. **The column is rent-reporting; admin labels are wrong.**
   Rename column conceptually to "rent reporting" in admin
   surfaces; FlexCredit (the lender-referral product) gets its
   own future column. **My read of CLAUDE.md prefers this** —
   the FlexSuite definition of FlexCredit is unambiguously
   lender-referral.
2. **The column is FlexCredit; tenant message is wrong.**
   Rewrite tenants.ts:777 to enroll in a lender-referral
   product instead of bureau furnishing. Removes the FCRA
   furnisher obligation.
3. **Both are intended; the column is overloaded.**
   Split into two columns (`credit_reporting_enrolled` +
   `flex_credit_enrolled`); fix the labels accordingly.

I did not edit either file. This requires a Nic decision.

## Decisions made during build

| Question | Decision |
|---|---|
| Take the small 3-route slice S375 recommended, or bundle in the 2 pass-throughs skipped in slice 2? | **Bundled — 5 routes / 9 tests.** Portability/decline + re-acceptance/preview are mechanical pass-throughs and were one mock-import each. Bundling closed out the entire Flex+portability tenant-side surface in one file instead of leaving 2 orphan routes for a future micro-slice. |
| Test the credit-reporting column with the FlexCredit mislabel cross-checked? | **Tested the route's actual behavior; flagged the mislabel separately.** The route's contract is "flip the column to TRUE and return the success message" — the test pins that. The product-naming question is independent and belongs in a handoff bug callout, not a test assertion. |
| Test the LIMIT 24 boundary by seeding 25 or 26 rows? | **26 rows + 1 other-tenant row.** 26 proves the cap (only 24 come back); the other-tenant row proves cross-tenant isolation in the same assertion. Single test does double duty without adding a separate `it()`. |
| Seed payments via `seedRentPayment` helper or raw INSERT? | **Raw INSERT.** `seedRentPayment` hardcodes `due_date = CURRENT_DATE`, which would break the DESC-ordering assertion across 26 rows. Raw INSERT with `CURRENT_DATE - ($i || ' days')::interval` gives the staggered dates needed. |
| Fix the FlexCredit mislabel in-session? | **No — out of scope.** The fix-it-right rule applies when the surrounding rot is in code we're touching. We touched tenants.ts:773-779 as a test target, not as an editor target. The mislabel is in admin.ts (a different file) and the resolution is a product call, not a refactor. |

## Verification

- `npx tsc --noEmit` clean on apps/api (0 errors after fixing
  3 helper-signature mismatches in the seed fixture).
- `npm test` in apps/api: **1124 tests across 65 files, 0
  failures**, 544.71s.
- 9 new test cases (`tenants-actions.test.ts`).
- 0 production bug fixes (the FlexCredit mislabel is flagged
  for Nic, not fixed).
- 0 production regressions.

No frontend touched, no shared-package touched, no migrations.

## Items deferred — what S377 could target

### tenants.ts remaining slices (~17 routes left)

S374 + S375 + S376 covered 23 of tenants.ts's 40 routes (~58%).
Remaining:

- **Invite + accept-invite + invite-info** (3 routes —
  tenant-add flow public)
- **Admin-facing /:id/profile + /:id/transfer +
  /:id/available-units** (3 routes)
- **Profile patch + avatar GET/POST + password** (4 routes)
- **Lease views + sign + addendums** (3 routes)
- **Work-trade + charge-account** (2 routes)

Natural next slice: **invite + accept-invite + invite-info**
(3 routes; the public tenant-onboarding flow). Or jump to
the lease views slice (3 routes, finishes the tenant
self-service action surface).

### **Pending Nic decision: FlexCredit ↔ rent-reporting**

See "Bug found" section above. Once Nic picks 1/2/3, the
admin.ts labels (or the tenants.ts route, or a schema
migration) get the matching follow-up edit.

### **NEXT FRESH-CONTEXT SESSION:** Checkr API wire-up

Memory note `project_checkr_access_unblocked.md` is still the
priority. Carries over from S375. Per
`feedback_checkr_otp_unrelated.md`, frame Checkr as
background-check product going live, NOT as unblocking OTP.

Slice 1 recon already done in S376 (see early portion of
this session before pivot):
- `services/backgroundProvider.ts` has the clean abstraction
- `routes/background.ts:333` has hardcoded `getProvider('mock')`
  — needs env-driven selector
- `routes/background.ts:697` uses `JSON.stringify(req.body)` as
  raw-body stand-in — needs `express.raw` wiring in `index.ts`
  before `express.json` for `/api/background/webhook/:providerName`
- Zero `CHECKR_*` env vars in `.env.example` or `validateEnv.ts`
- Intake collects `ssnLast4` only, not full SSN — product call:
  stay with last-4 (weaker trace) vs. collect full (intake form
  + encryption-at-rest review)

Three forks Nic owes:
1. Where credentials live + sandbox vs. prod
2. Which Checkr package (recommend `tasker_pro` ~$30-35
   wholesale, no credit pull)
3. SSN-last-4 vs. full SSN (recommend stay with last-4 for
   first wiring)

### Architectural / non-test (carried)

- **Unicode-capable font in flexsuitePdf**
- **responsibleParty source-comment drift fix**

### Hardening flagged (carried)

- **logAdminAction targetId-uuid audit**
- **silent-failure pattern audit**
- **schema-drift audit** — 4 instances (S355/S360/S370/S374)
- **arc-completeness verification at close time**

### Vendor-blocked / walkthrough-blocked / dev-team scope

(All unchanged from S375.)

## Items deferred (cross-session docket, post-S376)

- Consumer-side retention framing decision (S300) — Nic-pending
- Campground Master import path — Nic-blocked on sample
- 2FA fan-out — walkthrough-blocked
- Yardi GL-export columns, Rentec template (S293) — vendor-blocked
- FlexCharge Business Account Agreement signature capture (S309 option B)
- FlexDeposit eligibility-check workflow (S309 option C)
- Standalone POS-operator auth (S309 option D)
- Deposit-return ↔ unpaid-installment offset architecture call — Nic-pending
- SchedulePage booking-vs-lease shape audit — walkthrough-blocked
- Embed Unicode-capable font in flexsuitePdf — open architectural pick
- Credit-score formula + recompute test coverage — locked v1.0.0
- Visual review of reconstructed PmInvitationsPage — walkthrough-blocked
- posTerminal service tests (Stripe-boundary, low marginal yield)
- action.url scheme validation (defense-in-depth, no live risk)
- pm.ts remaining slices: property invitations / Connect / payouts / drilldown
- units.ts remaining: /:id/economics / /:id/eviction-mode (walkthrough-blocked)
- properties.ts remaining: units/bulk + photos + listings + apply + applications
- logAdminAction targetId-uuid audit (codebase-wide hygiene pass)
- silent-failure pattern audit (try/catch swallow class)
- schema-drift audit (4 instances — codebase-wide grep priority)
- arc-completeness verification at close time (process hardening)
- tenants.ts remaining: invite + accept-invite + invite-info +
  admin /:id/* + profile-patch/avatar/password + lease views +
  work-trade + charge-account
- **NEW (S376):** FlexCredit ↔ rent-reporting product naming —
  Nic-pending resolution; admin.ts labels and/or tenants.ts
  route message need follow-up edit once Nic picks
- **NEXT FRESH-CONTEXT SESSION:** Wire background.ts → Checkr
  API (credentials in hand 2026-05-26)

## Nic-pending

- Stripe live keys + production webhook URL registered
- Resend domain verification
- Plaid production keys
- Stripe Terminal hardware
- Consumer-side retention framing decision (S300)
- FlexCredit Lender partner selection
- SLA § 9.1.4(iii) deposit-return offset framing call
- **NEW (S376):** FlexCredit vs. rent-reporting product
  disambiguation (option 1/2/3 in Bug found section)

## What S377 should target

**Recommended path:**

1. **First**: surface the FlexCredit mislabel finding to Nic and
   get the option 1/2/3 call. If option 1 (column is rent-
   reporting; admin labels wrong), the fix is a 4-line edit in
   admin.ts:36/176/260/369 — fits in 5 minutes at the top of
   S377.
2. **Second**: next tenants.ts slice. Recommend **invite +
   accept-invite + invite-info** (3 routes, the public
   tenant-onboarding flow). This is the highest-yield slice
   for bug-surfacing: invitation flows are pre-auth-adjacent
   and tend to have permission / validation holes. ~6-8 tests.

If Nic prefers to pivot to Checkr at any point — that's the
locked priority for a *fresh* context, but the chain has only
moved 1 session deep so far; another tenants.ts slice or two
is safe.

---

End of S376 handoff. tenants.ts arc slice 3 of N covered
(5 tenant-action routes). 1124 tests / 65 files / 0 failures.
1 substantive product-naming bug flagged for Nic
(credit_reporting_enrolled ↔ FlexCredit mislabel).
