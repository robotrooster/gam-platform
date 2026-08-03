# SESSION 563 HANDOFF

**Theme:** Post-S562 continuation — tenant nav redesign, pay-in-full-only, lease renewal/auto-renew rework, FlexPay flat-$25 correction, and launch-state corrections. **⚠️ ALL WORK THIS SESSION IS UNCOMMITTED** (last commit `5e89b17` was the prior night). 17 modified files + new migrations. If testing on the deployed app, none of this shows until committed + deployed; localhost dev servers (with HMR) reflect it.

---

## SHIPPED (uncommitted, all typecheck-clean; tests green where noted)

### 1. Launch-state corrections (I had it wrong twice — now fixed in docs)
- **Stripe is NOT blocked.** Live keys (`sk_live`/`pk_live` + both webhook secrets) have been wired in `apps/api/.env` since **7/21** (`.env.bak-pre-live-20260721`). N1 + C3 DONE. Corrected the stale memory `gam-launch-accounts`, MEMORY.md, and LAUNCH.md §1 (they all wrongly said "blocked on sales-rep migration"). Real remaining launch work = C4 live-fire + C5 prod walkthrough + Nic's data entry (N2/N3).
- **C6 billing dry-check** run against demo data: invoice engine correct (4 apts bill Aug-1; RV 08 correctly held on unread electric submeter; RV 01 excluded needs_review). 38 engine tests green. Surfaced a launch dependency: units w/ tenant-responsible meters won't invoice until the meter's cycle read is verified.

### 2. Tenant nav redesign (`apps/tenant/src/main.tsx`)
- Emoji nav icons → monochrome **lucide** (grayscale idle, gold active), matching landlord. Browser-verified.
- Preferences: real icon + aligned (was a misaligned dot). "My Walkthroughs" capitalized.
- **Support tab removed** (chatbot floats globally via AgentChatWidget). Route + import removed.
- **Conditional tabs** (Nic's "don't show what they can't use" rule): Work Trade shows only w/ an agreement (`/tenants/work-trade`); Amenities only w/ an active **reservable** common area (`/common-areas/mine` filters `active AND reservable` — laundry/wifi don't count); My Walkthroughs only when the tenant has inspection videos.

### 3. Pay-in-full only (partials removed) — `payments.ts` + tenant + landlord
- No partial payments anywhere. `/pay-balance` rejects any amount ≠ exact balance (under AND over). Tenant UI: single "Pay $[balance]" button, no amount field. Landlord `PaymentAcceptanceCard` toggle removed. `accept_partial_payments` column now a dead fossil. FIFO tests rewritten; 100+ green. Memory: `gam-payment-application-fifo` updated.

### 4. Auto-renew retired + binding non-renewal + LANDLORD-FIRST renewal
Memory: `gam-auto-renew-retired-binding-nonrenewal` (full detail).
- **Auto-renew retired** (`processLeaseEnds` — both modes removed; every lease expires at end_date unless a signed successor drafted). Migration `20260728120000` flips existing active leases. Landlord `LeaseFormModal` auto-renew toggle removed.
- **Binding non-renewal, either party.** Tenant "no" is now binding written notice + confirmation modal ("liable through end_date; not an early move-out"); landlord notification retitled "Non-Renewal Notice". Not the same as `terminate-early` (early vacate, unchanged).
- **Landlord-first survey gate.** Migration `20260728140000` adds `leases.landlord_renewal_offered_at`. New `POST /leases/:id/offer-renewal` sets it + notifies tenant. Tenant survey (`showRenewalSurvey`) now requires `landlordRenewalOfferedAt` — never releases until the landlord offers. Landlord `RenewalDecisionModal` now: **Offer Renewal** / **Renew Now** / **Don't Renew**.

### 5. FlexPay = FLAT $25/month (was a never-implemented bug) — memory `flexpay-demand-test-rollout`
The whole stack ran the OLD `$5 + pull-day` ($6–$33) formula. Corrected to flat $25 everywhere:
- Backend: `FLEXPAY_MONTHLY_FEE=25`, `calculateFlexPayFee()` returns 25 (services/flexpay.ts). Retry stays $25 + `FLEXPAY_ACH_RETURN_FEE=$4` pass-through, no recalculation. flexpay.test updated (31 green).
- Tenant UI: enrollment card, change-day card, **the Flex Advantage card `price:` field ($6–$33 → $25/month) — the one most visible, missed on the first pass**, all copy. Admin dashboard `× $20 → × $25`.
- **ToS rewritten** to flat $25: `FLEXPAY_SUBSCRIPTION_TERMS.md` §3 + §4.1; `CONSUMER_TERMS_OF_SERVICE.md` §5.4 clause(a) + §9.2. CLAUDE.md FlexPay section corrected. Swept clean of the old formula.
- Pull day (1–28) still tenant-picked but SCHEDULING ONLY. Pre-launch survey mode = no enrolled tenants, no fee-data migration needed.

---

## MIGRATIONS APPLIED THIS SESSION
`20260728000000_manual_payment_recording` (prior night), `20260728120000_retire_lease_auto_renew`, `20260728140000_landlord_renewal_offer`.

## DEFERRED / NEXT
- **NEXT UP (Nic, fresh context): unbanked tenants / cash-kiosk pay** for fully-remote landlords — priority #1. Research rails: PayNearMe + retail cash networks (7-Eleven/Walmart), Stripe cash-payment options, prepaid-card ACH. Come with concrete options + costs.
- Also raised by Nic (discussions): mobile app (Capacitor) vs web separation; desktop app for internet-down resilience + local backup.
- `processLeaseEnds` regression test (no scheduler test harness exists yet).
- Manual-payment landlord modal + renewal confirmation modal: visual smoke (typecheck-clean, batch to Nic's walk).

## STILL LAUNCH-BLOCKING
Live Stripe cutover only (C4 live-fire + C5 prod walkthrough); all money code complete + tested.
