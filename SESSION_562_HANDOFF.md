# SESSION 562 HANDOFF

**Theme:** Cleared the three remaining S561 launch-critical bugs + built the manual-payment feature. Verified C3 (Stripe live wiring) was already done. This session's commit ALSO captures the large accumulated uncommitted work from S557–S561 (money-flow platform-holds rebuild, metering, onboarding, bug sweeps, doc consolidation) — none of it had been committed. `.claude/` stays gitignored.

---

## SHIPPED (S562, all tested + typechecked)

### 1. Processing-fee-not-charged on tenant-pays — FIXED (launch-critical money bug)
`apps/api/src/routes/payments.ts` — both `/:id/pay` and `/pay-balance`.
- Root cause: under the S560 platform-holds rewrite, the charge amount was pure rent even when `fee_payer='tenant'`, and `allocation.ts` sets `splittable=gross` for tenant-pays → landlord got full rent, GAM ate Stripe's cost every payment (violated the #1 no-fee-absorption rule).
- Fix: both routes now fetch `ach_fee_payer`/`card_fee_payer` from `property_allocation_rules` (LEFT JOIN) and charge `amount + processingFee` when `feePayer !== 'landlord'` (mirrors `allocation.ts` EXACTLY). `pay-balance` computes the fee once on the lump (single capped transaction). Landlord-pays charges pure rent; allocation splits the fee out at settle.
- Also fixed the stale `$0.10`→`$0.26` doc comment in `computeApplicationFee`.

### 2. Platform-fee passthrough leak — FIXED (same root cause, Nic approved)
Same two routes. If a landlord set `platform_fee_payer='tenant'`, the accrual was stamped claimed but the amount was never charged → GAM ate it. `passthroughAmount` (already filtered to `payer='tenant'` unclaimed accruals, so $0 when landlord-paid = launch default) is now added to the charge. Non-launch-blocking (Oak Park = landlord-paid) but closed while in the code.

### 3. CSS class/token vocabulary mismatch — FIXED + browser-verified (tenant + admin)
- **Tenant** (`apps/tenant/src/main.tsx`): added `--text-*`/`--border-*`/`--bg-*` token aliases in `:root` + long-vocab class aliases (`.btn-primary`/`.btn-ghost`/`.form-input`/`.modal-overlay`/`.modal-title` as extra selectors on the canonical short classes; new `.btn-link`/`.modal-header`). The whole lease/e-sign flow (`LeasePage`, `SignPage`, dialogs) had been rendering with undefined `--text-*` = invisible text.
- **Admin** (`apps/admin/src/main.tsx`): worse — NO modal/input/`btn-sm` styling at all + used `kpi-l/-v/-s` vs defined `.kl/.kv/.ks` + `b-green` vs `.bg2` etc. Aliased buttons/badges/kpi to canonicals + appended net-new `btn-sm`/modal set/`inp`/`fg`/`fl`. The FlexPay review modal's missing overlay is fixed (`modal-ov` now `position:fixed`).
- **GOTCHA (caught in-browser, not by tsc):** a CSS comment containing `--text-*/` had a `*/` that prematurely closed the comment and dropped `--text-0`. Verified every class/token resolves to the right computed color via browser probe. RULE: never put `*/` glob patterns in CSS comments.

### 4. Manual-payment (cash/check/money-order) rent recording + $10 fee — NET-NEW FEATURE
Was NOT a bug — no manual-payment infrastructure existed (CLAUDE.md said electronic-only; that line is now superseded — update it). Nic chose "build the full feature now."
- **Migration** `20260728000000_manual_payment_recording.sql` (APPLIED): adds `payments.manual_method` (cash/check/money_order CHECK) + `MANUALPAY` entry_description.
- **Shared** (`packages/shared/src/index.ts`): `MANUAL_PAYMENT_METHODS`, `MANUAL_PAYMENT_METHOD_LABELS`, `MANUAL_PAYMENT_FEE=10.00`, `PAYMENT_ENTRY_DESCRIPTION_LABELS` + `humanizeEntryDescription()`. Also added `FLEXPAY` to `PAYMENT_ENTRY_DESCRIPTIONS` (closed a long-standing DB-vs-shared drift).
- **Backend** `POST /api/payments/:id/record-manual` (payments.ts): `requirePerm('take_payment')` + `canManageLandlordResource`. Marks the rent row `status='settled'`, `platform_held=FALSE`, `stripe_payment_intent_id=NULL`, `manual_method` set. **KEY DESIGN:** reuses `settled` (not a new status) so it reads as paid everywhere (balance/FIFO/late-fee/rent-roll — no status sweep), and the weekly batch skips it because that path requires `platform_held=TRUE` → landlord (who already holds the cash) is never double-paid. `type='fee'` rows aren't disbursed either, so the $10 MANUALPAY fee stays GAM revenue (same as RETURNFEE). Fee WAIVED on the tenant's first rent payment on the lease (counts prior settled/paid_via_deposit rent). Eviction (`payment_block`) blocks recording, consistent with the pay routes.
- **Landlord UI** (`PaymentsPage.tsx`): "Record manual payment" action in the payment-detail modal for open rent rows — method picker + optional reference + confirm; success message states whether the fee was waived or the $10 was billed.
- **Tenant UI** (`PaymentsPage.tsx`): disclosure note (first payment free, then $10, pay through GAM to skip) + `MANUALPAY`/`RETURNFEE`/`LATEFEE` now render via `humanizeEntryDescription` (no raw enums).

### C3 (Stripe live wiring) — VERIFIED DONE (not re-done)
Nic corrected my stale memory. Confirmed in code: `express.raw` mount + `constructEvent` sig-verify on BOTH platform + connect webhooks, RAW events append-only (idempotency table + reversals `raw_event`), Financial Connections live in the ACH charge/setup, 3 Stripe secrets set in `.env`. Radar = dashboard-side (no code). Only unverifiable-from-code = live-vs-test key prefix + prod webhook endpoint registration (Nic's side, he says done).

---

## TESTS
- `payments.test.ts`: +10 (3 processing-fee + 1 passthrough + 6 record-manual) = 42 green.
- `s537-payment-fifo.test.ts`: +2 (pay-balance fee) = 8 green.
- Full affected surface (payments, fifo, webhooks, landlordPassthrough, late-fee): **101 green**. `tsc` clean across api/tenant/landlord/admin/shared.

---

## DEFERRED / NEXT SESSION
- **Visual smoke** of the landlord record-manual modal + tenant disclosure in-browser with real auth (typecheck + unit tests pass; visual not yet walked — batch into Nic's UI walk).
- **Update CLAUDE.md**: the "No cash/check support / electronic only" line is now superseded by the manual-payment feature; the S113 destination-charge section is already ⚠️-bannered.
- Pre-existing race (unchanged): in `/:id/pay` the passthrough accrual claim happens AFTER the charge; now that real money moves, the accepted "over-collection flagged for reconciliation" race has real consequence. Only triggers on tenant-paid platform fee (non-launch).
- The remaining S561 DEFERRED pile still lives in LAUNCH.md / the gam-bug-sweep-s561 memory.

## STILL LAUNCH-BLOCKING
- Only the live Stripe cutover (live keys confirmed + live-fire test + the C4 ACH-pull executor). All money CODE is complete + tested.
