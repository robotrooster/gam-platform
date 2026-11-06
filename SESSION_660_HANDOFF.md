# Session 660 handoff — FlexDeposit, and the day's deploys

## FlexDeposit: four pieces built and green, ONE piece left

All of this is in the working tree, tested, **not deployed**.

### Built (115 tests green across flexDeposit, moveInBundle, tenantDeposits)

1. **The landlord's books take the deposit when money lands.**
   `ledgerProjectors/tenantDeposits.ts` dates the custody posting from the first
   installment that actually SETTLED (`min(settled_at)`), not from
   `min(created_at)` = the enrolment day. No settled installment → no posting at
   all, so the deposit simply reads unpaid like any other.
   Nic: *"the landlord's books should only take the deposit when the fucking
   deposit is paid."*

2. **Installment 1 is funded like 2..N.** `settleFlexDepositMoveIn` is gone,
   replaced by `linkFlexDepositMoveInPayment` — it links the payment and settles
   nothing. GAM's whole service fee moved out of lease-finalize and into
   `reconcileSettledFlexDepositPayment` (installment 1 branch), so it books on
   real money.

3. **Cash and checks credit the installment.** `manualPaymentSettle.settleOneRow`
   now calls the reconcile for any settled FlexDeposit installment row.
   Previously the reconcile was wired to the Stripe webhook ALONE, so a desk
   payment settled the charge and credited the plan nothing.

4. **Enrolment no longer waits for the bank.** `getFlexDepositEligibility`
   refuses only somebody with NO bank link started (`no_bank_started`, new
   blocker); a link in flight (`tenants.bank_pending_since`) is enough.
   `/me` exposes `bankPending`; the tenant tile unlocks on it. The test titled
   *"microdeposits still in flight: offered"* now asserts what its title always
   said.

5. **The installment is a LINE ITEM on the invoice.**
   `moveInBundle.ts` writes it with `invoice_id` set and
   `Security deposit — installment 1 of N`. The deferral-credit row I built
   earlier is gone. Nic: *"The invoice is the sum of all the charges that they
   are about to pay... that installment is another line item on the bill. It's
   on the invoice."*

### THE ONE PIECE LEFT: the landlord's rendering

Same invoice, two renderings. The landlord's view must show the deposit **in
full** and read **paid in full from the FIRST payment** — not when the plan
completes. No extra rows; it is a rendering.

**And it is money, not wording.** Installments are BANK-ONLY (Nic, 10/28: *"they
cannot pay their installment in cash. It is only bank account verified"*), so the
front desk and the register must collect the WHOLE deposit — *"if they go into
the front desk to pay, it's going to try to charge them the whole thing."* The
desk collects from the invoice, which now carries the installment amount, so the
substitution changes what the register takes. Do that deliberately, with tests.

Where to work:
- `services/invoiceNotice.ts` `chargeLabel` / `chargeDetail` — the shared
  labeller the desk and the bill print both use. A deposit row currently returns
  'Security deposit'; the installment detail comes off `notes`.
- `routes/payments.ts` ~2318 — the desk's open-bills payload (`show(...)`,
  `bills[].rows`, `total`, `owed`). This is where the full-deposit amount has to
  come from, via a join to `security_deposits.total_amount`.
- `apps/landlord/src/pages/FrontDeskPage.tsx` and `BillPrintPage.tsx` are the
  landlord surfaces that read it.

### Cancelled, deliberately — do not rebuild

The **cash clawback** (an installment paid in cash to the landlord debited off
their payout) was specified on 10/28 and then withdrawn the same day by the
bank-only rule: no cash installment can happen. The credit-on-manual-settle path
(item 3) stays as a harmless safety net. See
memory `gam-flexdeposit-three-views-of-one-deposit`.

### Also deferred by Nic until before launch
- FlexCredit's invoice wording (*"FlexCredit, owed to GAM"*, continuous, not in
  the landlord's books) — check whether FlexCredit generates any invoice line at
  all today; if not, that is a build, not a label change.
- The left-owing split: what is LIVE moves the WHOLE collected installment to
  the owed landlord; Nic described the collecting landlord keeping part. Open
  question recorded in memory `gam-left-owing-collection-model`.

## Deployed today (in order)
1. Demo-matches-deploy rule in deploy.sh + the test-fixture collision fix.
2. The screening-tie fix (an approved screening is a company tie) + the lease
   takeover working from all four doors + the signed-successor fix so the
   nightly sweep cannot erase a handover.
3. The trailer takeover: a new contract that supersedes the old one on signature,
   in one packet. **Blue's live takeover completed end to end** — document
   35707858, old contract 971e2b8f superseded, new one a1cc1c79 active at his own
   terms ($100/mo × 36 against the old $200/mo × 120 remaining).
4. The lease signing fixes: end date unlocked (the dash that means
   month-to-month was the value that locked it), the term following the date in
   both directions, the Exhibit A overlay pinned to one pixel frame in both
   portals.
5. The payout cadence: Tuesday and Friday every week, the month-end run moved to
   the LAST business day, the adjacent scheduled day standing down, and holidays
   no longer pushing a payout onto the next day (which was manufacturing two
   payouts a day apart). Plus `month_end_sweep` as a real trigger so a sweep
   stops calling itself the weekly payout, and October's sweep relabelled.

## Not deployed
Everything in the FlexDeposit section above.
