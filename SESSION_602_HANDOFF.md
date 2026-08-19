# SESSION 602 HANDOFF — deposit-trust build, agent microscope, Snowbird resurrection + seasonal/FlexDeposit scoping

> A very large session. Three threads: (1) a deep **agent-vs-reality microscope** pass that found + fixed real
> bugs; (2) that surfaced Nic's **deposit-trust vision**, which became a full **money-flow build** (GAM holds all
> new-tenant deposits in a segregated trust, invests in T-bills, never batches them to the landlord); (3) an audit
> that **Snowbird seasonal tenancy was only ~1/6 built**, so we started finishing it. Plus scoping for FlexDeposit,
> seasonal pricing, and owner-occupied units. **3 migrations applied to dev `gam`. Nothing deployed. No commits.**

Read the new/updated memory files first — they carry the load-bearing directives: `gam-deposit-trust-model`,
`gam-no-partial-rent-payments`, `gam-owner-occupied-units`.

---

## WORKSTREAM 1 — Agent microscope (the original ask): combed by hand, dual-lens

Combed knowledge articles + prompts + tools against the REAL code (no fan-out, per [[gam-sweep-byhand-no-fanout]]).
**Clusters #2–#5 done** (tenant money; tenant deposit/flex/work-trade; tenant lease/docs/maint/inspect/entry/nav;
landlord money). **3 real bugs found + FIXED:**

1. **`how-payments-are-applied.md`** promised partial payments + pay-ahead — system is **pay-in-full only**
   (`payments.ts` /pay-balance rejects under/over-payment; the S537 partial toggle was removed). Rewrote the article.
   → recorded [[gam-no-partial-rent-payments]] (Nic: standing, platform-wide, protects eviction clock + FlexPay adoption).
2. **`get_my_payment_methods` tool** queried `user_bank_accounts` (the landlord PAYOUT-destination catalog — empty
   for tenants) → told ~every tenant "no payment method." Rewired to read the tenant's real **Stripe** methods
   (bank + card) via `tenants.stripe_customer_id`, with `chargeable`/`verificationPending`; degrades honestly on a
   Stripe error. Test updated.
3. **Inspection conditions** — article/tool/prompt said `good/fair/damaged/missing/na`; real enum was
   `excellent/good/fair/damaged_missing`. Fixed all three. **THEN (see WS4) Nic re-added `na`.**

**NOT combed (next session):** cluster #6 = ~29 landlord-ops + 3 sales + 6 shared articles; the agent backbone
deep-review (agentRunner backstops / agentEval / agentSession). `applicant-background-check` timers (6mo/90d/30d)
reviewed at claim-level, not code-verified.

## WORKSTREAM 2 — Deposit-trust build (the big one): CODE DONE, NOT DEPLOYED

Full model in [[gam-deposit-trust-model]]. GAM holds ALL new-tenant deposits in a **segregated trust/escrow**;
imported (pre-onboarding) tenants stay landlord-held; auto by `lease_source`, NO UI toggle; NEVER batch deposits to
the landlord; GAM allocates statutory interest; escrow → T-bills (returns also feed FlexPay float). Built + tested:

- **New deposits → `gam_escrow`** by `lease_source` (`leaseFeesSync.ts` held_by derivation) — native lease → GAM,
  imported → landlord unless turned over (FlexVault). Switches on the existing hold/interest/move-out-split rails.
- **Never-batch guard** (`landlordPassthrough.ts`) — deposits stay `platform_held` in trust through the weekly batch.
- Interest already gated by the state-rate catalog (`depositInterest.ts`) — no change needed (verified).
- Move-out split already wired for `gam_escrow` (`depositReturn.fireLandlordDisbursementTransfer`).
- **Agent** deposit articles reframed to the trust model + friendly holder label on `get_my_deposit`.
- **Admin trust-liability surface** — `GET /admin/deposit-trust/summary` (held count, principal that should be in
  trust, interest owed, by-state) + an Overview card with a by-state donut. 2 backend tests + FE typecheck green.
- **Marketing** landlord pitch STAGED as an HTML comment in `apps/marketing/src/index.html` (do NOT publish until live).

**GATED on Nic (not code):** stand up the physical **FBO/custodial trust account** + the sweep off Stripe.
Web-researched (verified): the structure is TWO LAYERS — a dedicated FBO/trust bank (Column N.A. or Increase Bank) +
a broker-dealer/RIA T-bill sleeve (Apex/Treasure); no turnkey 50-state vendor. Nic reaching out to **Jiko** first
(bank + broker-dealer one-stop); Column+Treasure fallback. **UPDATE: Jiko replied positively (Chandler) — sees a
fit; discovery call Fri 8/14 10am CT (= 8am Phoenix).** Must-confirm on the call before committing / dropping the
others: (1) account titled to GAM-as-custodian FBO tenants (segregated/bankruptcy-remote); (2) invest the pool in
T-bills in a GAM-OWNED account and keep the yield above required tenant interest — NOT per-tenant (Jiko's public
model is per-customer-name, so press this). Titling (GAM-as-custodian, keep yield above required
tenant interest) is the counsel question. **CANNOT invest deposits in index funds** (principal must be 100%
refundable; permissible-investments = Treasuries/govt MMFs only). Spread varies by state (FL keep-the-excess vs
MD/MA ~zero). **Don't take real deposits live until the account exists.**

## WORKSTREAM 3 — Snowbird audit + resurrection

Nic thought Snowbird was finished; **audit found only Phase 1 built.** Full per-phase status in
`SNOWBIRD_SEASONAL_SPEC.md`. Built this session:
- **Phase 2a** — `seasonal_tenancies` table (season window month/day, `is_priority`, generation bookkeeping; migration applied).
- **Phase 2b config** — `PUT/GET/DELETE /leases/:id/seasonal` (upsert one config per lease; typecheck + leases.test green).
- **Phase 5 (deposit half)** — booking deposit reconciled to spec: default **10%**, locked to **5/10/15/20**, rows
  conformed, zod tightened (`propertyBookingAdmin.ts`).

**REMAINING (next session):** Phase 2b **yearly generation job** (materialize the spot-locked recurring reservation,
resolve the cross-year window, couple to hibernate/resume) — the heart; Phase 3 (wire `is_priority` to
`relocateBlockingBookings` + relocation audit log); Phase 4 (guest-friction downgrade/auto-upgrade offer engine — biggest
net-new); Phase 5 payment split (card-transient/ACH-recurring); Phase 6 (tenant self-service reservation edit).

## WORKSTREAM 4 — Scoped/decided, NOT built

- **FlexDeposit as a launch product** — `FLEXDEPOSIT_LAUNCH_SCOPE.md`. Model settled: **custody + a rare move-out
  GAP backstop** (NOT credit/advance — Nic corrected me; no money advanced during tenancy, tenant never gets credit).
  Everyone eligible; **BG check STAYS required** (decided); start 2 installments → 3/4 on default data; target gap
  losses ≤1% of FlexDeposit revenue. **OPEN decisions B/C/D:** tenure/on-time gates? flat-2 vs risk-tier? gap funding
  source? Recovery already exists (GAM-First intercepts a missed installment from next rent).
- **Seasonal + weekend pricing** — `SEASONAL_PRICING_SPEC.md`. Per **subtype**; up to **2** season windows; **weekend**
  (Fri–Sun) rates for motel/furnished; override base nightly/weekly/monthly; precedence season>weekend>base. Not built.
- **Owner-occupied units** — [[gam-owner-occupied-units]]. Add `owner_use` status: no lease, no rent (anti-cheat),
  $2 fee waived, marked occupied (not bookable/vacant). Not built.
- **Inspection N/A (DONE this session)** — re-added `na` (reverses S573): enum/label/CHECK migration + move-out
  comparison SKIPS na + tool/prompt/article. Frontend condition picker = UI batch.

## MIGRATIONS APPLIED (dev `gam` only — NOT gam_test/prod)
- `20260812120000_seasonal_tenancies.sql`
- `20260812130000_booking_deposit_pct_steps.sql` (default 10, CHECK 5/10/15/20, backfilled)
- `20260812140000_inspection_condition_add_na.sql`

## DEPLOY STATE — nothing live
All dev source + dev-DB migrations. Go-live for the agent-article fixes needs: **API build+restart + KB re-ingest**
(`node -r ts-node/register src/services/agents/ingestKnowledge.ts`, targets `gam`). Deposit-trust + Snowbird also need
their remaining code + (deposits) the trust account before real money.

## OPEN DECISIONS FOR NIC
1. FlexDeposit B/C/D (above).
2. Snowbird Phase 5 payment-split details; confirm the guest-friction offer-window default (spec says 3d, 2–5 range).
3. Deploy timing (when to build+restart API + re-ingest KB so the agent fixes go live).

## UI-BATCH (cosmetic, when backend settles)
- Booking-deposit input → 5/10/15/20 picker.
- Inspection condition picker → add N/A option.
- Deposit-trust marketing pitch → uncomment when live.

## QUICK-REF
- Re-ingest KB: `cd apps/api && node -r ts-node/register src/services/agents/ingestKnowledge.ts`
- Agent tests: `cd apps/api && DB_NAME=gam_test npx vitest run src/services/agents/...` (NEVER without DB_NAME=gam_test)
- Specs: `SNOWBIRD_SEASONAL_SPEC.md` (per-phase status), `SEASONAL_PRICING_SPEC.md`, `FLEXDEPOSIT_LAUNCH_SCOPE.md`
- Next-session obvious start: Snowbird **Phase 2b generation job**, then cluster #6 agent comb.
