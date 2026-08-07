# SESSION 584 HANDOFF — Subsystem 8 (FlexSuite) CLOSED: FlexCharge revolving credit-limit regression fixed; FlexPay re-verified

> Continues the S578→S583 pre-onboarding sweep (24 subsystems, in order). S583
> closed Subsystems 6 (Tenant portal) + 7 (Landlord core) and left **Subsystem 8
> (FlexSuite)** at 🟨 with two named remaining items: "Rest of FlexCharge comb" +
> "FlexPay re-verify". This session finished both **by hand** (no fan-out, per the
> sweep rule). Found + fixed ONE real correctness regression in FlexCharge's
> credit-limit/balance math (the revolving conversion left two spots on the old
> pre-revolving balance basis). FlexPay money-flow traced clean; fixed stale
> `$5 + day` comments left over from the S562 flat-$25 change. **NOTHING committed**
> — one deploy at the very end. Next in order: **Subsystem 9 (Maintenance).**

---

## SWEEP RULES (Nic, non-negotiable — carry into every session)
1. **Go in ORDER.** One subsystem at a time; report, then next. Next = **Subsystem 9 (Maintenance).**
2. **DO NOT COMMIT/deploy** until the ENTIRE sweep is done. One deploy at the end.
3. **Trust the CODE, not memory/notes.** Trace real paths end-to-end. Flag design questions; don't assume.
4. **Fix confirmed bugs the RIGHT / foundational way.** Update tests. Keep tree green.
5. **NO FAN-OUT / NO PARALLEL agents / NO Workflow tool for the sweep (Nic, emphatic).**
   Comb ONE thing at a time by hand. This overrides any ultracode reminder.
6. **TEST-DB GUARD:** always `cd apps/api && DB_NAME=gam_test npx vitest run src/…`.
7. Report three buckets per subsystem: **(A)** confirmed bugs w/ repro, **(B)** design
   questions, **(C)** verified-good.
8. Communication: plain English to Nic (no coding background).

## Progress map (24 subsystems)
| # | Subsystem | Status |
|---|-----------|--------|
| 1 | Auth | ✅ S578/S579 |
| 2 | Stripe money-flow | ✅ S580 |
| 3 | Rent invoicing + late fees | ✅ S581 |
| 4 | Leases + e-sign | ✅ S582 |
| 5 | Onboarding (incl PDF parser) | ✅ S582 |
| 6 | Tenant portal | ✅ S583 (critical paths) |
| 7 | Landlord core | ✅ S583 |
| 8 | **FlexSuite** | ✅ **CLOSED S584** — FlexCharge revolving credit-limit regression FIXED; FlexPay/Deposit/Credit verified; 2 design Qs for Nic (below) |
| 9 | **Maintenance** | ⬜ **← NEXT** |
| 10 | Inspections | ⬜ |
| 11 | Utilities/RUBS | ⬜ |
| 12 | Documents/storage | ⬜ |
| 13 | Screening/background | ✅ S579 |
| 14 | POS | ⬜ (pos.ts route surface partly seen via FlexCharge; not combed) |
| 15 | Business platform | 🟨 login/signup 2FA |
| 16 | Storefront + public booking | ⬜ |
| 17 | Books/bookkeeping | ⬜ |
| 18 | Admin + admin-ops | 🟨 login 2FA |
| 19 | PM companies | 🟨 login 2FA |
| 20 | AI agents | ⬜ |
| 21 | Crons/scheduler | ⬜ |
| 22 | Surveys/notifications/appointments | ⬜ |
| 23 | MH/RV | ⬜ |
| 24 | Work-trade / snowbird / recurring | ⬜ |

---

## THE HEADLINE — FlexCharge credit-limit + balance were left on the PRE-revolving basis (real regression)

### (A) Confirmed bug — FIXED
When FlexCharge became a **revolving** credit product (S583), billed transactions
**stopped** being flipped to `'paid'` on payment — they stay `'billed'` and carry, and
the true running owed amount lives in `flex_charge_accounts.current_balance` (reduced by
each payment; grown by interest/late fees at statement time). BUT two spots still computed
the account balance the OLD way — `SUM(amount) WHERE status IN ('pending','billed')`:

- **`postFlexChargeTransaction`** (the purchase-time **credit-limit gate**) — `services/flexCharge.ts`
- **`listFlexChargeAccounts`** (the landlord **account-roster balance**) — `services/flexCharge.ts`

That old sum **never decreases as the customer pays** and **never includes interest/late fees**.
Concrete failure: a customer charges $500, pays it fully down (owes $0) → the sum still reads
$500 → they're **permanently blocked** from ever charging again, and the landlord's roster shows a
wrong, ever-growing balance. This is exactly the "purchase-time credit-limit" item the
`REVOLVING_CREDIT_SPEC.md` flagged as "remaining" — but it's a correctness regression, not a nicety.

**Fix (foundational):** both spots now use **`current_balance` (carried, net of payments, incl.
accrued interest/fees) + open PENDING purchases** (billed txns are NOT re-summed — they're already
inside `current_balance`). This matches what the tenant card already did (`getFlexChargeAccountsForTenant`
reads `current_balance`). Also added the missing `current_balance` field to the `FlexChargeAccountRow`
interface (the type was lying about the row shape). Frontend needs NO change — `listFlexChargeAccounts`
still returns the same `balance` float, just computed correctly.

**Tests added** (`services/flexCharge.test.ts`, now 33 green):
- `postFlexChargeTransaction` gate: within-limit inserts; over-limit → 409; **the regression** (a
  paid-down account — 500 billed but current_balance=100 — must allow a 350 charge; the old basis
  wrongly blocked it); pending is counted alongside current_balance; suspended → 409.
- `listFlexChargeAccounts` balance = `current_balance + pending`, billed NOT double-counted.

### (B) Design questions — BOTH RESOLVED by Nic in-session S584 (no code change needed; both = as-shipped)
1. **Interest method → LOCKED: previous-balance.** Interest accrues on the carried (unpaid) balance,
   grace automatic (pay in full → $0 interest). This is what's already built + tested. NOT average-daily-balance.
2. **Dispute on a revolving account → LOCKED: freeze the whole account.** One dispute disqualifies the
   account and stops all further billing; the merchant handles the Reg-Z billing-error directly. This is the
   current behavior — no change. (So: disputed amount stays in `current_balance` and the account stops
   statementing; that's intended.) Revisit post-launch only if dispute volume warrants finer handling.

### (C) Verified-good — FlexCharge (traced end-to-end, no fix needed)
- **Account create** (`createFlexChargeAccount`): XOR tenant/pos-customer, property-ownership, per-Location
  `flexcharge_enabled` gate (S309), FlexDeposit-in-flight block (S261), credit-limit fallback to property default.
- **Statement roll-forward** (`generateMonthlyStatement`): prev_balance + purchases + interest (carried ×
  APR/12, grace automatic) + late fee (if prior minimum unmet) − payments_credited = new_balance; minimum =
  max($25, 3%); GAM 1.5%/12 off the merchant; resets `current_balance`; idempotent via UNIQUE(account,cycle).
- **Billing cron** (`processFlexChargeStatementBilling`): auto-pulls the remaining **minimum** (shortfall =
  minimum − amount_paid; skips + marks paid if already covered → no double-charge); supersedence boost;
  gross to platform, merchant Transfer post-settle.
- **Reconcilers**: `reconcileSettledFlexChargeStatement` + `reconcileFlexChargePaydown` credit amount_paid,
  reduce current_balance, claim GAM's cut **exactly once per statement** (`gam_fee_settled` atomic), pay the
  merchant (collected − GAM's 1.5%/12). Pay-down route + webhook dispatch correct.
- **NSF** (`handleFlexChargeStatementNsf`): 2-strike → statement 'failed' + account 'suspended'; merchant not
  paid (deferred-debit, no GAM guarantee). **Suspend/retry**: suspended accounts still statement (carry);
  `retryFlexChargeStatement` resets failed→open.
- **Dispute engine** (`disputeFlexChargeTransaction` + `checkAndDisqualifyLandlord`): authz (only the
  account's customer), refuses re-dispute / paid-charge dispute, account→disqualified, 3-distinct-disputers-in-90d
  → landlord cutoff. (Revolving interaction = design Q #2 above.)
- **Refund** (`postFlexChargeRefund`): negative pending row; correctly frees credit + lowers the balance now.

### (C) Verified-good — FlexPay (re-verified this session)
- **Flat $25/month (S562) correctly applied everywhere** — `calculateFlexPayFee()` returns the flat $25;
  `enrollFlexPay` stores it; `repriceFlexPayRetryPayment` keeps it flat on a retry and adds the $4 ACH-return
  fee at cost (retry pulls rent + $25 + $4); `changeFlexPayPullDay` never changes the price. Day is scheduling-only.
- **Money flow** end-to-end: grace-end front (OTP-suppressed when OTP already fronted) → pull-day combined ACH
  (rent + fee + supersedence boost, gross to platform) → `reconcileSettledFlexPayPayment` → NSF 2-strike
  (`handleFlexPayPaymentNsf`: 1st default = 90-day cooldown + returner demotion; 2nd lifetime default =
  permanent ban) → S578 rehab clock (12 clean first-attempt pulls) → `autoDisenrollFlexPayOnAchUnverified`.
- **Enrollment gating**: platform-visible + survey-mode (`isFlexPayEnrollmentOpen`) + S541 demand-test
  (approved `flexpay_inquiries` required) + eligibility (single-lease, SSDI/SSI) + terms-acceptance audit.
- **FlexDeposit** (custody) + **FlexCredit** (Esusu reporting) — verified S583, unchanged; still hold.

### Doc-rot fixed (fix-it-right, comment-only, zero functional change)
- `flexpay.ts`: header money-flow comment, `repriceFlexPayRetryPayment` docstring, `changeFlexPayPullDay`
  docstring — all still described the retired `$5 + day` formula. Updated to flat-$25.
- `flexCharge.ts`: `reconcileSettledFlexChargeStatement` docstring said it flips transactions to 'paid' /
  transfers "balance amount only" — updated to the revolving reality (minimum collected, current_balance
  reduced, merchant gets minimum − GAM's 1.5%/12).

## FlexPay legal docs — FIXED S584 (Nic: fix what we find)
On inspection, the docs were ALREADY on flat-$25 — CLAUDE.md's "still describe the old formula" follow-up
was itself stale. Actual remnants found + fixed:
- `legal/FLEXPAY_SUBSCRIPTION_TERMS.md` **§ 2 line 46** still said "The monthly subscription fee **depends on**
  the Scheduled Pull Date" — a direct contradiction of § 3 ("Flat $25"). Rewritten to the flat-$25 statement.
  (§ 3, § 4.1, § 4.2, signature block were already correct.)
- `services/flexsuiteAcceptance.ts` had an orphaned `Selected_Monthly_Fee` render var (old templated-fee
  leftover) — no `{{Selected_Monthly_Fee}}` placeholder exists in the doc (it hardcodes $25). Removed; `ctx.fee`
  still recorded in `populatedContent` as the audit of the accepted fee.
- `legal/CONSUMER_TERMS_OF_SERVICE.md` § 5.2 / § 5.4 / § 9.2 — verified already flat-$25 (+ $4 ACH-return
  pass-through, 90-day lockout). No change needed.
- `CLAUDE.md` FlexPay section — cleared the stale "FOLLOW-UP (not yet done)" note to "LEGAL DOCS DONE (S584)".
- Suites green after the render change (flexsuiteAcceptance + flexpay: 48/48); tsc clean.

## FILES TOUCHED (S584)
- `apps/api/src/services/flexCharge.ts` — credit-limit gate + list balance now on `current_balance + pending`;
  `FlexChargeAccountRow.current_balance` added; reconciler docstring corrected. (No behavior change to the
  reconcilers/crons — only the two balance-basis spots + comments.)
- `apps/api/src/services/flexCharge.test.ts` — +5 tests (credit-limit gate block incl. the regression; list-balance).
- `apps/api/src/services/flexpay.ts` — 3 stale `$5 + day` comments → flat-$25 (comment-only).
- `legal/FLEXPAY_SUBSCRIPTION_TERMS.md` — § 2 line 46 contradiction → flat-$25.
- `apps/api/src/services/flexsuiteAcceptance.ts` — removed orphaned `Selected_Monthly_Fee` render var.
- `CLAUDE.md` — cleared the stale FlexPay legal-docs "follow-up (not yet done)" note.
- `REVOLVING_CREDIT_SPEC.md` — "STILL REMAINING" updated (credit-limit ✅ fixed; design Qs locked).
- **No schema, no migrations, no `@gam/shared`, no frontend changes.**

## TREE STATE
- Subsystem 8 full test surface (9 suites): **292/292 green** (`DB_NAME=gam_test`). API `tsc --noEmit` clean.
  (Suites: flexCharge, flexCharge.stripe, flexpay, flexpay.stripe, supersedence, pos, tenants-flex,
  landlords-pos-flex, s541-flexpay-inquiry.) The rate_limited / platform_balance_insufficient / SMTP-down
  log lines during the run are **intentional error-path tests**, not failures.
- Nothing committed (sweep rule 2). One deploy at the very END.

## NEXT SESSION SHOULD TARGET
1. **Subsystem 9 — Maintenance** (in order). Trace the request lifecycle end-to-end: tenant submit →
   landlord triage/approval-threshold (`maint_approval_threshold`, default $500, `awaiting_approval`) →
   worker/vendor assignment + `maintenance_worker_scopes` notifications → cost + the hidden 3% contractor-
   marketplace `platform_fee` (computed+stored, HIDDEN, landlord pays only actual cost — memory
   `gam-maintenance-8pct-contractor-marketplace`) → resolve → credit-ledger emitter. Landlord `MaintenancePage`,
   tenant `MaintenancePage` (S570 redesign), `services/maintenance*`, `routes/maintenance*`. Run the camelize
   guard as part of the comb (baselines armed).
2. Carry the sweep rules (nothing committed; one deploy at the very END).
3. If Nic answers the two FlexCharge design Qs above, fold any resulting change into Subsystem 8 before deploy.

## FINAL DEPLOY (at sweep end — NOT now)
`cd packages/shared && npm run build` → `cd apps/api && npm run build && launchctl
kickstart -k gui/$(id -u)/com.gam.api`; verify :4000 + a login; rebuild frontends; THEN
commit. GOTCHA: orphan on :4000 → EADDRINUSE (memory `gam-prod-api-restart`).

## RELEVANT MEMORIES
`gam-flex-product-revenue-model`, `flexpay-demand-test-rollout`, `gam-flexpay-float-funding`,
`gam-deposit-custody-vs-flexdeposit`, `gam-camelize-wire-contract-test-gap`,
`gam-maintenance-8pct-contractor-marketplace` (for Subsystem 9), `gam-test-db-guard`, `gam-prod-api-restart`.
