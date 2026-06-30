# SESSION 513 HANDOFF

Continuation of the launch sequence. Two arcs: (A) finished the platform-fee backend
(#34) + de-staled CLAUDE.md's Flex Suite section to the S512 custody model, and (B)
built the S512 fee-payer lock (onboarding ACH election + card-always-tenant lock), which
also surfaced and fixed a latent onboarding-step-1 break. One migration this session. All
work uncommitted (Nic decides commits).

Key Nic decision this session: **leave the $10 platform-fee minimum PER PROPERTY for now**
— reverting the S512 "per connected payout account" idea (deferred, not dropped). So the
existing `$10/property` copy + `launchPlatformFeeForProperty` are correct again; do NOT
re-plumb the accrual cron for per-account.

---

## A. Platform-fee backend (#34) + CLAUDE.md de-stale

- **#34 backend** — retired the stale `$15/$5` OTP/direct tiers in the two remaining
  landlord-/admin-facing surfaces → flat **$2/occupied** via shared
  `LAUNCH_PLATFORM_FEE.PER_OCCUPIED_UNIT`:
  - `routes/admin.ts` `/income/projection` (otpFees/directFees now × $2; KPI label already
    said "occupied units × $2", value now matches).
  - `routes/units.ts` `/economics` (per-unit `platformFee` + `lifetimePlatformFees`/net;
    occupied = active OR direct_pay → $2, vacant $0). The internal `calcNetPerUnit` econ
    fields (gross=$15) are GAM unit-economics, unused by the page — left as-is.
  - Verified live: `/economics` → platformFee 2, lifetimePlatformFees = $2 × 27mo = $54;
    `/income/projection` → otpUnitFees 4 (2×$2) + directUnitFees 6 (3×$2) = $10 = 5 occ × $2.
  - tsc clean; no test asserted the old numbers.
- **CLAUDE.md Flex Suite section rewritten** to the S512 model (the big stale block):
  - **FlexDeposit advance/SLA → CUSTODY** (no float, $3/mo custody fee, SSDI/SSI-only +
    income-verified, 2–6 installments, forward-on-move, no recourse/collections/CRA). Flags
    that `services/flexDeposit.ts` still implements the OLD advance code (the #3 follow-up).
  - **FlexPay** — kept the date-formula pricing (still current per Nic) + added the S512
    eligibility/retry/90-day-lockout controls.
  - **FlexCharge** — "organized by GAM, not operated by GAM"; landlord Participation
    Agreement §17 also carries FlexCharge terms.
  - **FlexCredit** — added positive-only / no-warranty / opt-out / no-refund.
  - "SLA installment" → "custody installment" in the GAM-supersedence + collections paras;
    recharacterization-risk para updated (custody removes the advance → stronger non-credit
    posture); `FLEXDEPOSIT_SLA_TEMPLATE.md` marked archival.
  - Banking fee-payer bullet got the S512 lock note (card always tenant).
  - Shared `FLEX_DEPOSIT_TIERS` comment de-floated (custody rationale).

## B. Fee-payer lock + onboarding ACH election (S512 follow-up #2)

Model (Nic, S512): tenant pays BOTH ACH + card by default; landlord may elect **at
onboarding** to cover **ACH only**; **card is ALWAYS the tenant's** (locked).

- **Migration `20260624120000_landlord_default_ach_fee_payer.sql`** — `landlords
  .default_ach_fee_payer text NOT NULL DEFAULT 'tenant'` (+ CHECK). Holds the onboarding
  election; card has no landlord default (hard-locked in code). Applied; schema.sql regen'd.
- **Backend:**
  - `complete-onboarding` accepts `coverTenantAch` (bool) → sets `default_ach_fee_payer`
    and **bulk-applies** to the landlord's existing properties' allocation rules (+ heals
    `card_fee_payer`→'tenant'). Catches the first property created at step 1.
  - Property-create: `card_fee_payer` **hard-locked to 'tenant'**; `ach_fee_payer` inherits
    `landlords.default_ach_fee_payer` when not explicitly sent. PATCH clamps card→'tenant'.
  - **Latent bug fixed:** the create zod schema required fee payers (`refine`), so onboarding
    step-1 — which posts a property with **no allocationRule** — was **400'ing** (verified
    live before the fix). allocationRule is now optional (`.default({})`), refine dropped;
    card lock + ach-inherit make explicit payers unnecessary.
- **Frontend:**
  - `OnboardingPage.tsx` banking step: "Who pays the ACH processing fee?" toggle (Tenant
    pays / I'll cover ACH) + note that card (3.25%) is always the tenant's. Sent as
    `coverTenantAch` in the complete-onboarding payload.
  - `PropertiesPage.tsx` edit form: the Card-processing FeePayerToggle replaced with a
    locked "Tenant pays — always" display; form init pins `cardFeePayer='tenant'`.
- **Tests:** properties happy-path card assertion → 'tenant'; the old "missing payers → 400"
  test split into "no payers → 201 (ach inherits 'tenant', card 'tenant')" + "allocationRule
  omitted → 201 (onboarding fix)"; 2 new landlords tests (no-election stays tenant;
  coverTenantAch=true → landlord default + portfolio apply + card stays tenant). **47
  green** (properties 30 + landlords 17).
- **Verified live:** create w/o allocationRule → 201; create w/ cardFeePayer='landlord' →
  stored card='tenant'. Probe rows cleaned up.
- **Frontend:** tsc clean + `vite build` green. NOT visually previewed (OnboardingPage
  banking step needs a fresh un-onboarded landlord; the preview tool's landlord launch
  config was stale per S512). Offer a visual pass next session if wanted.

## Open follow-ups (launch)
1. **#3 FlexDeposit code rework** — `services/flexDeposit.ts` (1548 lines) still implements
   the advance/eat-the-gap model; terms + CLAUDE.md are now custody. The big, legally
   sensitive one — give it its own session. (FLOAT_FEE_MO=$20 in payments.ts/admin flexPay
   line is the old float fee; custody fee is $3 / `FLEX_DEPOSIT_CUSTODY_FEE` — fold into #3.)
2. **Per-connected-payout-account fee minimum** — deferred by Nic (per-property for now).
   When revived: it's an accrual-cron re-architecture (`platformFeeAccrual.ts` floors per
   property; `platform_fee_config.min_per_property`), not just copy.
3. **#4 inspection media-401** — separate spawned session (don't duplicate).
4. Optional: render the ToS into the app's real /terms surface; counsel pass on custody
   framing.

## How to resume
- `~/gam-start.sh` boots everything. Demo logins + ports per CLAUDE.md / S512 handoff.
- Admin 2FA login for live checks: login → `~/gam-admin-code.sh` → POST /api/auth/totp/verify.
- Green suites this session: `cd apps/api && npx vitest run src/routes/properties.test.ts
  src/routes/landlords.test.ts`.
