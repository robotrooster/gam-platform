# Session 259 — closed

## Theme

FlexCharge polish (statement history + in-app tenant dispute flow) +
POS multi-terminal sync surfaced as separate-session scope + FlexDeposit
missed-installment legal-remedy 6-fork resolution. OTP cron-timing
question scrubbed from DEFERRED (locked decision).

## Items shipped

### 1. FlexCharge statement history view (landlord)

New `GET /api/landlords/flex-charge/accounts/:id/statements` endpoint
returns `{ statements, disputes }` for the account. Service-layer
function `listAccountStatements(landlordId, accountId)` in
`apps/api/src/services/flexCharge.ts` — landlord-scoped, 404 if
caller doesn't own the account. Returns both statement history
(cycle, balance, fee, total, due date, status, billed/settled
timestamps, failed reason) and any disputed transactions (amount,
disputed_at, reason).

Landlord UI: new "Statements" button on each `AccountActions` row
opens a `StatementHistoryModal` showing two sections when relevant:

- **Disputed charges** — surfaces only when at least one disputed
  tx exists. Per-tx: amount, disputed/charged dates, customer's
  dispute reason quoted. Red-tinted card.
- **Statements table** — newest cycle first. Columns: Cycle, Balance,
  Fee, Total, Due date, Status (badge), Settled. Failed statements
  show the failed_reason inline.

Also surfaces `disqualified_reason` on the account row when status
is `disqualified` — shows "customer dispute" for the `tenant_dispute`
canonical reason, raw text for others.

### 2. FlexCharge in-app dispute flow (tenant)

Backend was already shipped S253 (`disputeFlexChargeTransaction`
service + `POST /api/tenants/flexcharge/dispute/:txId` route). This
session added the missing tenant UI.

Extended `getFlexChargeAccountsForTenant` in
`apps/api/src/services/flexCharge.ts` to include transactions per
account (pending / billed / disputed only — paid charges go through
refund flow, not dispute). Result shape unchanged for unaffected
fields; each account now includes a `transactions[]` field.

Tenant UI in `apps/tenant/src/main.tsx → FlexChargeAccountsCard`:

- Per-account "Recent charges" section showing up to 8 transactions
- Each row: amount, date, badge (`on statement` for billed,
  `disputed` for disputed)
- "Dispute" link button on pending/billed transactions, hidden
  on disputed and on non-active accounts
- `FlexChargeDisputeModal` with red-tinted warning panel:
  "This permanently closes your FlexCharge tab at this merchant.
  You'll still owe any other unpaid charges on this account. The
  merchant will review your dispute and respond directly. GAM does
  not arbitrate the underlying charge."
- 500-char reason textarea with live counter
- Replaced the old "contact GAM support" footer copy with a
  clearer warning about the consequences of disputing

**Pos_customer dispute deferred — out of scope.** Pos_customers
don't have GAM portal logins, so they can't dispute in-app via the
same flow. Backend dispute service supports `disputerPosCustomerId`
but there's no UI path. For v1, pos_customer disputes go through
the merchant (who can contact support). Token-emailed dispute link
(S258 onboarding pattern) is the natural future shape if volume
justifies; not blocking launch.

### 3. FlexDeposit missed-installment legal-remedy framework — 6 forks resolved

Surface only — no build this session. Decisions captured for the
next session's implementation work.

| Fork | Decision |
|---|---|
| **F1 — Acceleration trigger** | **2-strike NSF** → remaining balance becomes immediately due. Matches FlexPay NSF posture; one fail of forgiveness before terminal. |
| **F2 — GAM clawback posture** | **GAM keeps funds in escrow throughout the lease.** Deposit shows as "funded" on the landlord view at move-in (no actual hand-off). At lease-end GAM settles to landlord with whatever's collected; GAM eats any gap then. Implication: all FlexDeposit deposits force `held_by='gam_escrow'` regardless of property default. **No Connect Transfer to landlord at move-in.** GAM has the full lease window to keep collecting. |
| **F3 — Tenant cure path + ACH ordering** | **Terminal default** — defaulted = no cure, full balance due. FlexDeposit ToS gives GAM ACH priority. **Pull schedule (revised post-fork-resolution):** primary at `rent_due − 5 days`, retry at `rent_due − 1 day` if primary fails. Tighter window kills last-minute-deposit gaming. **GAM-supersedence on all ACH pulls** (broader product rule, not just FlexDeposit) — see "Supersedence model" below. **ToS clauses required (tenant-signed only)** — see "ToS language" below. The 2-strike grace IS the cure window; no additional 7-day window. |
| **F4 — Landlord-side surface** | **Zero.** Landlord has no knowledge of FlexDeposit's existence as a tenant-facing product. No opt-in toggle, no per-property setting, no disclosure copy, no badge. Memory `project_flexsuite_otp_hidden.md` updated to make this rule explicit and permanent. |
| **F5 — Custody fee on defaulted plans** | **Continue charging.** GAM still has at least the partial deposit in custody; fee accrues. No cron change needed — defaulted plans stay enrolled. |
| **F6 — Per-state legal carve-out (S177 test)** | **No carve-out.** FlexDeposit default is a private credit arrangement between GAM and the tenant. The landlord's eviction rights are derivative of the lease's rent terms (already covered by existing eviction-mode workflow). Nothing here is a hard-compliance scenario. Stay generic. |

**Supersedence model (Nic S259, load-bearing rule):**

Every successful tenant ACH pull routes through GAM platform first.
Tenant's outstanding GAM-side balances (FlexDeposit installments,
FlexCharge balance, FlexPay fees, custody fees) get satisfied
oldest-first. Surplus continues to the landlord. **Applies to rent
pulls too** — if a tenant has unpaid GAM debt, their rent pull
satisfies that debt before any money reaches the landlord. Lease
obligation is met (rent paid in full on landlord's books); net-to-
bank reflects supersedence.

**Implementation pattern:** At rent PaymentIntent creation, compute
`tenant_gam_outstanding`. Set
`application_fee_amount = standard_platform_fee + min(rent_amount, tenant_gam_outstanding)`.
`transfer_data.destination` still points at landlord's Connect
account. Stripe routes net automatically. On webhook, distribute
the boosted application_fee internally to the specific GAM
obligations being settled.

**Landlord-facing accounting:** payment.status = `paid` for the
full rent amount; net-to-bank line shows the actual disbursed
amount (which may be less than rent if supersedence applied).
Two-number display. Landlord has **zero knowledge** of which Flex
product superseded — just sees the dollar gap, not the cause.

Saved as permanent memory rule (`project_gam_supersedence_routing.md`).

**ToS language (tenant-signed only, F3):**

> "FlexDeposit installments are pulled from your bank account on a
> schedule set at enrollment. These pulls may occur before any rent
> payment scheduled to the same bank account in the same cycle. You
> authorize GAM to attempt installment pulls regardless of your rent
> obligations to your landlord."
>
> "If an installment pull fails, GAM may re-attempt the missed amount
> on your next scheduled pull date in addition to that cycle's
> installment ('catch-up pull'). After two consecutive missed
> installments, your full remaining balance becomes immediately due
> ('plan acceleration')."
>
> "GAM and your landlord are separate parties. Missed installments
> do not relieve your rent obligations under your lease. Insufficient
> funds caused by GAM's installment pull may result in failed rent
> payments, which are governed by your lease, not by this agreement."

**Legal framing recorded in the handoff (Nic's framing):**

The two contracts (FlexDeposit ToS = GAM↔tenant; lease = landlord↔tenant)
are independent. Tenant signs both, consents to both. GAM has no
eviction recourse but doesn't need one — landlord's eviction-for-
non-payment-of-rent is the natural backstop if a tenant defaults on
FlexDeposit so badly that rent fails too. Federal Reg E covers ACH
authorization on the tenant signature; no state-specific carve-out.

**Build scope when decisions ship (next session):**

1. Migration: `security_deposits.balance_due_full_at` (timestamp),
   `security_deposits.balance_due_total` (computed remaining at
   acceleration). Force `held_by='gam_escrow'` for all FlexDeposit
   deposits (migration backfills existing rows that should be GAM-held).
2. `services/flexDeposit.ts`: NSF handler fires acceleration on 2nd
   miss (set balance_due_full_at + balance_due_total, mark plan
   `accelerated` — new status), single ACH pull attempt at the full
   balance, transition to `defaulted` on failure.
3. `services/flexDeposit.ts:fireDepositGapFunding`: remove the
   landlord-Connect-Transfer path for landlord-held deposits.
   Everything stays in gam_escrow until lease-end.
4. Pull-day schedule: at FlexDeposit enrollment, compute and lock
   `installment_primary_pull_day = clamp(rent_due_day - 5, 1, 28)`
   and `installment_retry_pull_day = clamp(rent_due_day - 1, 1, 28)`.
   Retry fires only when primary failed.
5. **GAM-supersedence routing (load-bearing, all-pulls rule):**
   - New service `services/supersedence.ts` (or extend
     `services/allocation.ts`): `computeTenantOutstandingGamBalance(tenantId)`
     returns sum of unpaid FlexDeposit installments + FlexCharge
     balance + FlexPay fees + custody fees, ordered FIFO.
   - Rent PaymentIntent creation path: boost `application_fee_amount`
     by `min(rent_amount, tenant_gam_outstanding)` on top of standard
     platform fee. Stripe still routes via `transfer_data.destination`.
   - Webhook `payment_intent.succeeded` for rent: distribute the
     boosted-fee portion internally — mark FlexDeposit installments
     paid, settle FlexCharge balances, etc. (oldest-first FIFO).
   - Same pattern on FlexDeposit pull webhooks — if a FlexDeposit pull
     succeeds and the tenant has OTHER unpaid GAM debts, the surplus
     within that pull satisfies them too.
6. ToS update: the three clauses go in the existing FlexDeposit
   tenant-signed agreement template (`apps/api/src/services/flexDepositDocuments.ts`
   or equivalent).
7. Tenant LeasePage: "Balance due in full" surface when accelerated,
   one-tap-pay button.
8. Landlord dashboard payment view: two-number display where
   relevant — "Rent paid: $X" (gross/lease status) + "Net to bank:
   $Y" when supersedence applied. No mention of WHICH GAM product
   superseded.
9. Lease-end settlement: deposit-return engine reads what's actually
   collected vs. what was promised, GAM eats the gap.

Likely 2-3 sessions — supersedence is the biggest piece (touches
allocation engine, rent webhook handler, dashboard accounting).
Split: session A backend schema + supersedence engine + ToS;
session B FlexDeposit acceleration + tenant UI; session C landlord
two-number dashboard + lease-end wiring.

### 4. OTP cron-timing — scrubbed from DEFERRED

Locked decision (Nic's 4th time confirming this session): OTP
disbursement cron fires last business day of month → payment lands
with landlord on the 1st. Current `isLastBusinessDayOfMonth` fire
+ 2-day Connect-to-bank payout is the intended behavior. Updated
the OTP entry in DEFERRED.md from "non-blocking fork open" to
"Closed — locked S259." Memory `project_otp_cron_timing_locked.md`
created to prevent future re-surfacing.

## Decisions made during build

| Question | Decision |
|---|---|
| Statement history surface — modal vs expandable row vs separate page? | Modal launched from a per-account "Statements" button. Keeps the main accounts table dense, drill-down on demand. |
| Surface disputed transactions alongside statements? | Yes, top section of the same modal when present. Disputes don't roll into statements (account flips to disqualified at dispute time, gen-cron skips), so they need a parallel surface. |
| Tenant dispute scope — pos_customers too? | Tenants only. Pos_customers have no portal login; token-emailed dispute link (S258 onboarding pattern) is the natural future shape, not blocking. |
| Replace "contact GAM support" copy? | Yes — replaced with structural disclaimer: "Disputing a charge permanently closes your tab at that merchant. Use this only for charges you didn't authorize or that the merchant won't resolve directly." |
| FlexDeposit landlord-side disclosure copy on the property settings? | **Rejected by Nic.** Landlord has zero knowledge of tenant-facing Flex products. Memory rule hardened. |

## Files touched (S259)

```
apps/api/src/services/flexCharge.ts          (+ listAccountStatements,
                                              AccountStatementRow,
                                              DisputedTransactionRow,
                                              extended getFlexChargeAccountsForTenant
                                              to include per-account
                                              transactions; ~+70 lines)
apps/api/src/routes/landlords.ts             (+ GET /flex-charge/accounts/:id/statements;
                                              ~+10 lines)
apps/landlord/src/pages/FlexChargePage.tsx   (+ Statements button +
                                              StatementHistoryModal +
                                              DisputeRow/StatementRow
                                              interfaces +
                                              disqualified_reason
                                              display; ~+115 lines)
apps/tenant/src/main.tsx                     (+ recent-charges section
                                              per account +
                                              FlexChargeDisputeModal +
                                              replaced support-route
                                              copy; ~+85 lines)
DEFERRED.md                                  (~ OTP entry: open fork →
                                              closed-locked;
                                              ~ FlexCharge polish:
                                              statement history shipped;
                                              ~ POS multi-terminal:
                                              moved to "approved scope,
                                              needs S260 scope-shaping")
SESSION_259_HANDOFF.md                       (this file)
~/.claude/.../memory/project_flexsuite_otp_hidden.md
                                             (rewritten — hard rule:
                                              landlord has zero
                                              knowledge of tenant-facing
                                              Flex products)
~/.claude/.../memory/project_otp_cron_timing_locked.md
                                             (new — OTP timing locked,
                                              never re-surface)
~/.claude/.../memory/MEMORY.md               (+ 2 entries updated/added)
```

## Verification

- `cd apps/api && npx tsc --noEmit` → clean
- `cd apps/landlord && npx tsc --noEmit` → clean
- `cd apps/tenant && npx tsc --noEmit` → clean

## Carry-forward — S260+

### S260 scope candidates (in priority order)

1. **POS multi-terminal session sync — scope-shaping session.** Per
   Nic in S259: "build it." Recon-found this is greenfield: POS cart
   is pure client-side `useState`, no `pos_sessions` table, no sync
   transport. Before code lands, four product calls are needed:
   - User story: two cashiers ringing the same customer in tandem,
     or two cashiers on parallel orders with manager visibility?
   - Sync transport: polling (cheap, current Express patterns work),
     SSE (one-way push, fine for status updates), or WebSocket
     (bidirectional, needs new infra).
   - Concurrency model: shared cart per property (CRDT/last-write-wins),
     or cashier-owned sessions with handoff?
   - Realtime threshold: how stale is too stale — 1s, 5s, 30s?
   Recommend kicking off S260 with these 4 questions before writing
   schema.

2. **FlexDeposit missed-installment legal-remedy build.** All 6
   forks resolved this session (see above). 7-step build plan
   captured in handoff. Probably 2 sessions to ship end-to-end.

### Vendor-blocked (unchanged)

- **Checkr Partner** — credentials pending (was expected Monday
  5/11; still pending Tuesday 5/12)
- **FlexCredit** — CredHub callback + Esusu email pending

### Pre-launch ready (unchanged)

All unblocked code work shipped through S258 plus S259's FlexCharge
polish. FlexDeposit legal remedy + POS multi-terminal are the two
remaining code-work items, both with paths forward.

## Revised count

| Bucket | Pre-S259 | Post-S259 |
|---|---|---|
| FlexCharge polish (statement history + in-app dispute) | 2 open polish items | **Both shipped** |
| OTP cron-timing | "Nic-input-blocked fork" | **Closed — locked** |
| FlexDeposit legal remedy | 6 forks open, no implementation plan | 6 forks resolved, 7-step build plan ready |
| POS multi-terminal sync | "Likely premature" | **Approved for S260 scope-shaping** |
| Vendor-blocked | 2 | 2 |
| Pre-launch unblocked code work | 0 (per S258) | 1 (FlexDeposit remedy build; POS sync needs scope-shape first) |

---

End of S259 handoff.
