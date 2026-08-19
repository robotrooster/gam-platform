# FlexDeposit as a Launch Product — Build Scope (S602)

**Status:** SCOPE ONLY — not built. Awaiting Nic's decisions on the flagged items below.

## The model (settled)
FlexDeposit = the **custody model + a self-funded move-out gap backstop.** NOT credit/advance.
- Tenant pays **their own** deposit in installments; GAM holds what it collects (`gam_escrow`).
- Landlord carries a book credit for the full deposit but gets nothing until move-out; keeps only actual damages, rest is the tenant's.
- GAM advances nothing during the tenancy; the tenant never receives money/credit from GAM.
- **Gap backstop (net-new):** at move-out, when the collected amount < the landlord's damage claim AND the tenant is unrecoverable, GAM covers the difference to the landlord and absorbs it as a business cost.
- **$3/mo** custody fee (`FLEX_DEPOSIT_CUSTODY_FEE`) while held. Target gap **losses ≤ 1% of FlexDeposit revenue.**

## Change list

### 1. Open eligibility to everyone — `services/flexDeposit.ts::getFlexDepositEligibility`
Current blockers: `not_ssi_ssdi`, `ach_unverified`, `bg_not_approved`/`no_bg_result`, `insufficient_platform_tenure` (30d), `insufficient_on_time_payment_history`, deposit-row/risk checks.
- **DROP `not_ssi_ssdi`** (line 126) — everyone eligible, anti-discrimination. ✅ decided.
- **DECISION A — background check:** BG-approved is currently required and supplies `risk_level` (which drives the installment tier). If everyone's eligible we likely drop the risk-tiering (see #2), so does BG stay required at all? Options: (a) drop BG entirely, (b) keep BG-approved as a fraud gate but stop using risk_level for tiering.
- **DECISION B — fraud gates for a brand-new tenant:** `insufficient_platform_tenure` (30-day) and `insufficient_on_time_payment_history` will **block a new tenant enrolling at move-in** — which is exactly the "somebody new signing up" case Nic wants. Keep (blocks new signups), relax, or drop? The 2-payment split + gap-cap already limit exposure, so these may be droppable.
- Keep `ach_verified` (need a chargeable method) + the deposit-row structural checks.

### 2. Installment ladder starts at 2, data-gated to 3→4 — `packages/shared getFlexDepositMaxInstallments` + `flexDeposit.ts`
Current: `max_installments` tiered 2–6 by (deposit amount × risk_level).
- **Replace with a global cap that starts at 2**, raised over time as loss data proves out. Suggest a single config `FLEX_DEPOSIT_MAX_INSTALLMENTS` (start `2`), superadmin-overridable, that caps whatever the tier would return. `enrollFlexDeposit` already validates 2..6 → tighten to `2..FLEX_DEPOSIT_MAX_INSTALLMENTS`.
- **DECISION C:** flat cap for everyone (simplest, matches "start at 2"), or keep the risk tier *under* the cap (lower-risk tenants could still be held to 2 at launch anyway)? Recommend flat 2 at launch.

### 3. Move-out gap backstop (net-new money-flow) — `services/depositReturn.ts`
At `finalizeDepositReturn` / `fireLandlordDisbursementTransfer`, for a `gam_escrow` FlexDeposit deposit where `collected_amount < landlord_damage_claim` (capped at `total_amount`):
- Pay the landlord the **full damage claim** (not just what was collected) — GAM funds the gap from the trust/platform balance.
- Record the gap as a **GAM loss** row (new ledger/loss-tracking type) so it rolls into the 1%-of-revenue metric.
- Only when the tenant is **unrecoverable** (GAM-First already intercepts a missed installment from the next rent payment — `services/supersedence.ts`; the real loss is only tenants who default AND leave). No collections against the departed tenant (consistent with the no-recourse Flex posture).
- **DECISION D:** confirm the gap is funded from the deposit trust pool vs a separate GAM loss-reserve line (accounting placement).

### 4. Loss / recovery tracking → the 1% target
- New metric: `sum(gap losses) / sum(FlexDeposit revenue)` where revenue = $3/mo fees (+ optionally held-deposit yield). Surface on the admin Overview near the deposit-trust card. Alert if it approaches 1%.
- The installment-expansion (2→3→4) should be **gated on this metric** staying well under target.

### 5. Turn the rollout flag on
- `isFeatureEnabled('flexdeposit_rollout_visible')` → set the `flexdeposit_rollout_visible` system feature ON (currently OFF). Do this **last**, after the above + counsel on the trust structure.

## Frontend
- Tenant enrollment surface already exists (`GET/POST /api/tenants/flexdeposit*`, `apps/tenant`). Update copy for the everyone-eligible + 2-payment framing; remove SSI/SSDI language from the tenant-facing flow.

## Open decisions (need Nic)
- **A** — keep or drop the background-check requirement.
- **B** — keep/relax/drop the 30-day tenure + on-time-history fraud gates (they block new signups).
- **C** — flat 2-installment cap for everyone vs. risk-tier-under-cap.
- **D** — gap-backstop funding source (trust pool vs GAM loss-reserve).

## Legal (counsel list — same conversation as the trust account)
- The gap-backstop's substance-over-form recharacterization footnote (weak; no advance, no injured party).
- Money-transmitter / custody analysis (belongs to the trust-account work, not this).
