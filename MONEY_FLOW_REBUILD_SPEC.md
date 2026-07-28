# Money-Flow Rebuild — Platform Holds + Friday Batch (SPEC)

S560, Nic. Rebuild the rent money-movement layer FROM Stripe destination charges
(money → landlord at payment time) TO **platform-holds-then-batches** (money
stays in GAM's platform account, landlords batched out Friday). Do the CODE side
now; verify the Stripe/live-account side in the later fresh-context Connect
session. See memory [[gam-money-flow-platform-holds]].

**Guiding win:** the platform-hold path already EXISTS as the "landlord Connect
not ready yet" safety valve. This rebuild mostly *promotes it to the default* and
moves its trigger from the `account.updated` webhook to the Friday cron, plus
builds the genuinely-new chargeback netting/clawback subsystem.

---

## Current state (verified)
- **Charge:** `createRentPlatformCharge` (platform hold) OR `createRentDestinationCharge`
  (money → landlord Connect + GAM's cut skimmed via `application_fee_amount`),
  chosen by `landlordConnectReady` in `routes/payments.ts` (`/:id/pay` ~404-430,
  `/pay-balance` ~755-773). Ready → destination; not ready → platform + `platform_held=true`.
- **Settle** (`webhooks.ts payment_intent.succeeded`): `executeRentAllocation`
  writes LEDGER ONLY (`user_balance_ledger`: owner_share/manager_fee/pm_company_fee);
  moves no money. PM + manager Transfers fire post-commit (real money, via
  `source_transaction` = the charge).
- **Friday batch** (`autoPayouts.ts`): `stripe.payouts.create` from EACH landlord's
  OWN Connect balance → their bank. NOT a platform→landlord transfer. (Assumes the
  money is already on the landlord's Connect — true only under destination charges.)
- **Platform-held funds** move to the landlord ONLY via `landlordPassthrough.ts
  reconcilePlatformHeldPayments`, triggered ONLY by `account.updated`: sums unfired
  `allocation_owner_share` rows → ONE aggregated platform→landlord `transfers.create`.
- **Chargebacks/returns:** `losses.payments='application'` (GAM eats it);
  `recordDisputeEvent` writes an audit row only. NOTHING recovers rent money from a
  landlord today. (This is bug-sweep #4.)

## Target model
- Every payment (card + ACH) → `createRentPlatformCharge` → platform balance,
  `platform_held=true`. No destination charge. No `application_fee` skim needed.
- Ledger allocation unchanged (owner_share already nets out GAM fee + supersedence
  + manager/PM cuts) — the owner_share row IS "what GAM owes this landlord."
- **Friday cron (Mon on US holiday)** for each landlord: sum unfired owner_share
  rows, SUBTRACT any open chargeback/return receivable (netting), and if net > 0:
  `transfers.create` platform→landlord Connect, then `payouts.create` landlord
  Connect→bank. Stamp the ledger rows fired.
- GAM keeps its cut by simply not transferring it (it never leaves platform).
- **Chargeback/return:** hits the platform balance (money's on platform). Record a
  receivable against the landlord. Net it against the next Friday batch. If no
  incoming money nets it within **2 weeks**, fire a **direct clawback**
  (`transfers.create` reversal / debit + reach out to landlord).

## Reuse (already built) vs new
REUSE: `createRentPlatformCharge`; `payments.platform_held`; `landlordPassthrough`
aggregation (generalize to run on the Friday cron for ALL landlords);
`autoPayouts` holiday/Friday gating (`shouldRunToday`/`thisWeeksAutoPayoutDate`)
+ its payout-to-bank step; the owner_share ledger.
NEW: chargeback/return receivable table + netting + 2-week-cap clawback cron;
the "always platform charge" switch; rework `gam_supersedence_amount` capture
(no longer folded into application_fee).

## Build order (each phase tested; nothing committed)
1. **[DONE 7/27 — Phase 1, 59 tests green, tsc clean]** Always platform-charge.
   payments.ts BOTH routes (`/:id/pay` + `/pay-balance`) now always call
   `createRentPlatformCharge` and set `platform_held=TRUE`; destination-charge
   path bypassed. application_fee no longer skimmed at charge (GAM keeps its cut
   by not transferring it; settle-time allocation ledger records who's owed).
   The `!landlordConnectReady` admin nudge kept + reworded ("held, can't batch
   out until Connect onboarding done"). `gamSupersedenceAmount` still computed +
   stored. `createRentDestinationCharge` now unused in payments.ts (dead code —
   Phase 5 removes). payments.test.ts "Connect-ready → destination" test rewritten
   to assert platform charge + held.
2. **Friday batch = transfer + payout.** Generalize `reconcilePlatformHeldPayments`
   into a Friday-cron batch that, per landlord, nets receivables then
   transfers platform→landlord Connect and pays out to bank. Replace/rewire
   `autoPayouts` self-payout with this. Keep holiday gating. Tests.
3. **Chargeback/return netting + clawback (net-new).** Receivable table;
   dispute/return webhook handlers write receivables; Friday batch nets them;
   2-week aging cron fires the direct clawback. Tests.
4. **PM/manager cuts** — see decision D2 below.
5. **Cleanup** — CLAUDE.md S113 architecture section updated to the new model;
   remove now-dead destination-charge path if fully unused.

## Decisions (Nic — RESOLVED)
- **D1 — batch timing (RESOLVED):** ONE weekly batch. Use FREE STANDARD payouts
  only — NEVER Instant Payouts (those cost ~1%). Standard payouts take ~2 business
  days to LAND, so the batch INITIATES mid-week (~Wednesday, the day that lands the
  money in the landlord's bank by Friday) — NOT on Friday (Friday-initiate lands
  the following Tue, breaking the "by Friday" promise). NO backward holiday
  compensation: on holiday weeks the money just lands the following Monday and
  everyone expects that. Exact initiation day pinned to the live account's real
  payout speed (T+1/T+2) during the Stripe session. Transfers platform→Connect are
  free; only Instant Payouts cost.
- **D2 — pay only what's owed (RESOLVED — NOT a frequency feature):** ONE weekly
  batch for everyone (landlord, PM company, on-site manager). Each entity is
  transferred ONLY what they are OWED and have not yet been paid. Owed nothing that
  week → paid nothing. Overpayment is structurally impossible: the batch moves only
  owed-and-unpaid ledger rows and stamps each `stripe_transfer_id` when it fires,
  so it can never go out twice. (This is the existing ledger idempotency applied at
  the batch — a PM whose full monthly cut went out on the first batch simply has no
  unfired rows the following weeks.) No per-entity schedules; no frequency config.
- **D3 — losses config stays `application` (CONFIRMED):** platform holds the money,
  so a chargeback hits the platform balance and GAM recovers via netting/clawback —
  no Stripe losses-config change.
- **D4 — clawback mechanism (DEFERRED):** Nic wants more context before deciding
  (reverse a prior transfer vs. a negative-balance debit vs. other). Bring options
  when Phase 3 (chargeback/clawback) is built. 2-week aging cap already set.

## Risk + verification
Core rent money — highest-risk area. Build incrementally, keep every payments/
webhook/allocation/payout test green, add tests per phase. STRIPE-SIDE (live
Connect account, real transfer/payout/chargeback behavior) verified in the later
fresh-context session with live keys (N1) via the C4 live-fire test. No commits;
unstaged for review.
