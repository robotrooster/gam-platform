# SESSION 520 HANDOFF

Theme: **FlexSuite launch-readiness — make all four Flex products "ready but
hidden, flip on at the drop of a pin."** Continues S519 (same working session;
S519 covered the Master Schedule / booking / RV-site work). This file covers the
FlexSuite audit + the fixes that came out of it: flag plumbing, FlexPay
completion, and ToS alignment. All Flex products remain **OFF/hidden**. All work
uncommitted (Nic decides commits).

> Goal (Nic): FlexSuite is not a launch feature but lands "very soon" — it must
> be code-complete and cleanly flippable, not half-wired.

---

## Audit result (5 parallel read-only audits, cross-verified)

| Product | State |
|---|---|
| **FlexDeposit** | ✅ Ready. Full S514 custody model (installments 2–6, $3/mo custody fee, missed≠default, cross-property forwarding, move-in settlement, crons, webhooks, tests). The CLAUDE.md "old advance code" warning is **stale** — code is custody. |
| **FlexCharge** | ✅ Ready for launch use (landlord-operated): per-Location enablement, 1.5% statement fee, charge/refund/statement/billing/dispute/merchant-payout, crons, ~2,200 lines of tests. Gap: **standalone POS-operator accounts** (no operator auth/KYC). |
| **FlexPay** | ✅ Completed this session (see below). |
| **FlexCredit** | ❌ Not built (~5%): a boolean + a stub endpoint that returned a false "$5/mo reported to all 3 bureaus" message. No Esusu client, reporting, billing, opt-out. Vendor-blocked. Now gated + the false message suppressed. |

---

## Shipped this session

### 1 · Flag plumbing (unblocks flip-on for ALL four)
- **Migration `20260627150000_flexsuite_feature_flags_seed.sql`** — seeds all 5 flags
  (`flexpay`/`flexdeposit`/`flexcharge`/`flexcredit`/`otp` `_rollout_visible`) as rows, **all `enabled=false`**,
  `ON CONFLICT (key) DO NOTHING` (prod-safe, never clobbers an admin-set value). The dev `system_features`
  table was EMPTY (rebuilt from schema.sql snapshot which lacks the original migrations' seed INSERTs).
- **`setFeatureEnabled` → upsert** (`INSERT … ON CONFLICT (key) DO UPDATE`). It was UPDATE-only, so toggling
  a missing-row flag silently no-op'd — the super-admin toggle couldn't actually turn products on. Now it can.
- **FlexCredit flag added** (`flexcredit_rollout_visible`, had none) and **`POST /enroll-credit-reporting`
  gated** on it — while OFF it returns `{visible:false}` and does NOT flip the column or emit the false message.

### 2 · FlexPay — completed (every audit gap closed)
- **90-day re-enroll lockout** — constant was 60; aligned to the ToS (`FLEXPAY_NSF_COOLDOWN_DAYS = 90`).
- **SSDI/SSI gate** — `not_ssi_ssdi` added to eligibility, reusing the existing `tenants.ssi_ssdi` field
  (same one FlexDeposit uses). No new field.
- **Deposit gate = FlexDeposit-funded ONLY** (Nic correction) — FlexPay gates on an in-flight FlexDeposit
  plan (`flex_deposit_active`, clears when the plan completes). It does **NOT** gate on generic
  `security_deposits` funded status — landlords onboarding bring tenants with deposits paid off-platform whose
  imported rows read "unfunded"; those must not block. (An over-broad `deposit_not_funded` gate was added then
  removed per this correction.) Also fixed a stale `'accelerated'` plan-status (S514 dropped it).
- **Auto-disenroll on ACH suspend wired** — `autoDisenrollFlexPayOnAchUnverified` + the OTP equivalent were
  exported but never called; now fire at the zero-tolerance NACHA return site (`routes/payments.ts`).
- **Re-priced retry + ACH-return pass-through** (Consumer ToS § 4.1/4.2) — `repriceFlexPayRetryPayment` runs
  in `processAchRetries` for `entry_description='FLEXPAY'` payments BEFORE the confirm: recomputes the fee to
  the retry day (`$5 + retry-day`, clamped 28), adds the bounced attempt's ACH-return fee, recomputes the
  supersedence boost, and **updates the existing PaymentIntent amount** (`paymentIntents.update`, since a PI
  amount can't change on confirm). If reprice fails → skip confirm (no stale pull) + alert.
  - **Caveat:** the ACH-return fee is a constant `FLEXPAY_ACH_RETURN_FEE = 4` approximating Stripe's published
    fee. True per-return "actual cost" needs Stripe balance-transaction reconciliation — only works with live
    Stripe keys (launch-infra). Documented in code.
- **Change pull day (next-cycle-effective)** — `changeFlexPayPullDay` service + `PATCH /tenants/flexpay/pull-day`
  + tenant UI ("Change day" button on the enrolled card → compact slider modal). Safe because the
  `flexpay_advances` row snapshots pull_day+fee at grace-end, so a change only affects the NEXT cycle's advance
  and can't disturb/dodge an in-flight pull — hence no outstanding-balance block (Nic's call).

### 3 · ToS alignment (`legal/CONSUMER_TERMS_OF_SERVICE.md`)
- § 9.2 pull-day clause: removed "may not change while a balance is outstanding" → now "takes effect next
  cycle; outstanding balance doesn't block." (FLEXPAY_SUBSCRIPTION_TERMS.md § already said this.)
- FlexPay eligibility intro: "deposit paid in full" → "complete a FlexDeposit plan if you're using one; an
  already-paid/off-platform deposit doesn't affect eligibility." (Matches the corrected code.)
- Re-pricing (§ 9.2 / FLEXPAY Subscription Terms § 4.1-4.2) and the 90-day lockout were already correct.

---

## Decisions (Nic, 2026-06-27)
- FlexCharge is **done for launch** (landlord-operated). Standalone POS operators = **after Flex**, built as a
  `business_owner` capability (reuse the existing Business-portal account model — do NOT build a new
  `pos_operator` role).
- FlexPay deposit gate = FlexDeposit-funded only (not generic deposits).
- Pull-day change = next-cycle-effective, no balance block.
- Build the re-priced retry now ("full product ready to launch at the drop of a pin").

## SHUTDOWN STATE
- Migration applied: `20260627150000_flexsuite_feature_flags_seed`. schema.sql regen'd. (S519's
  `20260627130000`/`140000` already handed off.)
- All 5 Flex/OTP flags confirmed `enabled=false` in the DB. Frontend also hides via tenant `LAUNCH_HIDDEN`
  (`/services`,`/credit`,`/my-disputes`), landlord `LAUNCH_HIDDEN` (`/flex-charge`), POS `LAUNCH_HIDE_CHARGE`.
- Tests: **202 green** across flexpay, flexpay.stripe, achRetry, tenants-actions, tenants-flex, flexCharge,
  flexDeposit, otp, payments. API + tenant tsc/builds green.

## How to flip a Flex product ON (when ready)
1. Super-admin → System Features (admin portal :3003) → enable `<product>_rollout_visible` (toggle now upserts).
2. Frontend un-hide: tenant `apps/tenant/src/main.tsx` `LAUNCH_HIDDEN` (remove `/services` etc.); FlexCharge
   also needs landlord `LAUNCH_HIDDEN` minus `/flex-charge` + POS `LAUNCH_HIDE_CHARGE=false`; rebuild/redeploy.
3. FlexCredit additionally needs the Esusu build first — do NOT flip it on.

## What next session should target
- **FlexCredit build** — vendor-blocked: Esusu contract/credentials + product calls (which bureaus, qualifying
  events, billing). Then: `services/esusu.ts`, payment-settlement reporting hook, `flex_credit_submissions`
  audit table, opt-out, billing, disclosure/consent.
- **Standalone POS operators** — as a `business_owner` capability (auth/KYC already exist there).
- **FlexPay return-fee actual-cost** — replace the `FLEXPAY_ACH_RETURN_FEE` constant with Stripe
  balance-transaction reconciliation once live keys are in.
- Everything else launch-side is vendor/infra-gated (see WALKTHROUGH_CHANGES.md).

## Key files
- `apps/api/src/services/flexpay.ts` (gates, reprice, pull-day change), `services/achRetry.ts` (reprice hook),
  `services/systemFeatures.ts` (upsert), `routes/tenants.ts` (flexpay routes + credit-reporting gate),
  `routes/payments.ts` (auto-disenroll wiring), `db/migrations/20260627150000_*`,
  `apps/tenant/src/main.tsx` (FlexPayChangeDayModal), `legal/CONSUMER_TERMS_OF_SERVICE.md`.
- Re-run: `cd apps/api && npx vitest run src/services/flexpay.test.ts src/services/flexpay.stripe.test.ts`
