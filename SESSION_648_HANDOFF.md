# Session 648 Handoff — 2026-09-16

Everything below is committed, deployed (`deploy.sh`, all surfaces in sync, last suite 7,508 green), and pushed. Nothing is uncommitted. Nic went home and will be back tomorrow with more.

---

## 1. Built and live this session

### Page 8 / move-in and billing cycle (answers to the S647 questions)
- **Page 8 is the move-in invoice.** Fee boxes pre-fill from the property fee list, per property AND per unit type. Onboarding residents get $0. For new tenants, First month's rent and Proration can be typed (for specials); Total due is computed and locked. Page 8's deposit mirrors page 2 (onboarding: $0). New `utility_deposit` fee type. Works for any landlord's uploaded template, not just Nic's.
- **Rent due rule per property:** everyone on a fixed day (1st–28th, with proration), or each tenant's move-in day (no proration; 29th–31st → the 1st). A landlord can give one tenant their own due day. Mid-month move-ins pay proration only, or proration + the next month (a property setting).
- **What follows each tenant's due date:** late fees and work-trade settlement. The GAM $2 fee stays calendar-based. Meters are read on the last business day before each tenant's due date (skipping weekends and holidays).
- **Onboarding late-fee waiver:** the landlord opts in per property. Unanswered = late fees apply.
- **Broken/stuck meter estimate:** a landlord setting per property (Mountain View on). When off, the meter is flagged broken and no utility bills until it's repaired; marking it repaired requires a fresh starting reading.

### Money correctness
- **Every dollar counted once:** one Outstanding Balances line per person (multiple leases merged); credits allocated once everywhere; general credit scoped to the landlord.
- **Payment overages:** only cash gets change. Check or money order overpayments always become credit.

### Tenant signing flow
- **Unsigned-lease lock-in:** a tenant with an unsigned lease sees only the signing flow (no nav, no logout).
- **Invite vs signing:** the new-tenant/onboarding choice exists only in the invite flow.
- **Fixed:** the Remind link bug; contact edits on unsigned drafts.

### Register
- **Pay links** (emailed) and standing **QR codes** (dump station), plus a Pay Links tab. The standalone register app (pos.goldassetmanagement.com) is now in `deploy.sh`.

### Every cent through GAM (Nic's directive)
Nic: "money all needs to flow through the platform. Every single cent... We are gonna hold all funds even if briefly."
- **Register and pay links:** counter card sales, pay links, stay deposits, business invoices (hosted link, customer portal, recurring auto-charge) and business register card sales are all **GAM platform charges**. No destination or direct charges remain.
- **Readers:** pair to GAM's account in a per-property (or per-business) Terminal Location.
- **Held funds:** `held_payout_items` is the one ledger of what GAM holds for a landlord or business outside rent. Positive = owed to them; negative = refunds, chargebacks, GAM fees.
  - The landlord's weekly batch pays rent plus held items in one transfer.
  - Businesses get the same batch (`reconcileBusinessHeldFunds`, run in `autoPayouts`). `platform_transfer_intents` now has `business_id`.
  - A negative total carries forward to the next run.
- **Batch race fixed:** the batch now locks and stamps the exact rows it summed. Before, a payment landing mid-batch could be marked paid out without being in the transfer.
- **Sale and capture together:** recording a card sale captures the card in the same step, on both registers. Card sales that didn't go through the reader are refused. The business register's "card (recorded)" option is **removed** (Nic).
- **Chargebacks:** on any held charge they belong to the payee (disputed amount + Stripe's fee), netted from the next payout. Nic: there's no customer to contact.
- **Business monthly fee:** netted from held money first; a Stripe account debit is the fallback.
- **Bank payments on checkout:** nothing is marked paid or held until `checkout.session.async_payment_succeeded`. Previously they were marked paid on completion, which was a bug.
- **Stay deposits:** card only (Nic), card fee on top. The booking site and the guest agent quote deposit + fee.
- **Invoice payments:**
  - Each payment row tracks `refunded_amount`. Refunds go back against real payments: online ones first (newest first), and the rest is recorded as paid back by hand.
  - "Mark paid" adds a payment row instead of overwriting a deposit.
  - The auto-charge itemizes its payment. Bank payments are recorded as `ach`.
  - GAM's invoice cut is taken once, when a payment is recorded. The customer-portal link and the auto-charge never took it before.
- **Daily 3:45 Phoenix check (`heldReconcile.ts`):**
  - A GAM charge with nothing recorded → critical admin alert.
  - A payee owing GAM back for 14+ days → warning.
- **Deleted:** the unmounted legacy `/api/terminal` route (Nic).
- **Fixed:** the business reader connection token was being minted on the wrong account.

### Who pays the card fee (Nic)
- **The setting:** per property, `register_card_fee_payer` (counter + pay links) and `booking_card_fee_payer` (stay deposits), each `customer` (the default) or `landlord`.
  - GAM's 3.5% + $0.55 is taken either way (`cardFeeSplit` in shared). When absorbed, it comes out of the payout.
  - A pay link keeps `card_fee_on_top` fixed from the moment it's sent.
  - It's set in the "Card fees" card on the property page, via `PATCH /properties/:id/processing-fee-payers`, and through the agent action `set_card_fee_payers`.
  - **Rent is unchanged:** tenants always pay the card fee.
- **Kept on `properties`, not `property_allocation_rules`:** that table's `card_fee_payer` is the rent setting, locked to the tenant. `payments.test` guards that no other table carries a column with that name.

### Data fixes (prod)
- **Clay Simpson** (Mountain View RV 25) → $495. Backup: `~/gam-backups/s648-clay-rv25-*`.
- **Unsigned page-8 drafts** (Oak Park RV27, Mountain View RV27): boxes retagged and restamped. Backup: `s648-page8-drafts-*`.

---

## 2. Open — ask Nic

1. **Business card rates:** business card fees are lower than landlord card fees (register 2.9% + $0.10, invoices 3.25% + $0.30, versus landlord 3.5% + $0.55). Should they match?
2. **Changing the due day on an already-signed lease:** an addendum was recommended. No answer yet.
3. **Property settings questionnaire:** deferred ("we'll talk later"). The question list is in memory `gam-property-settings-questionnaire`.
4. **Stripe:** confirm with the Stripe rep the assumption that GAM pays Stripe's fees on connected accounts. Order a BBPOS WisePOS E reader (it pairs to GAM's account now).
5. **Russ Fuller's $37.60 credit:** stays.

## 3. Still to build
- **Register:** ringing up a night/week stay should create the booking on the schedule (quote → hold → pay link that expires with the hold → confirm). The backend pay-link side already confirms a `bookingId`.
- **Front desk:** a card option on Record Payment (hidden until a reader is paired).
- **Signing plan leftovers:**
  - Bulk entry → a one-at-a-time signing queue.
  - A tenant "something's wrong" button.
  - Flag undelivered emails and allow resend.
- **Native apps:** Capacitor wrappers. Then the PM deal: bulk import and a scale check.
- **Business portal:** not hosted anywhere and not in `deploy.sh`. Its register changes are ready for when it launches.
- **Cleanup:** `/tmp/gam-api.log` is 41 MB with no rotation.

## 4. Working rules reinforced
- **Migrations and the live build:** migrations apply to prod immediately, but code ships later. **Never drop or rename a column the running build still uses.** Add first, deploy, then drop in a follow-up migration. This session broke that for about a minute (restored at once, no errors in `/tmp/gam-api.log`).
- **Guard tests:**
  - The portal-agent allowlist rejects any path containing `card`.
  - `payments.test` rejects any `*_fee_payer` column outside `property_allocation_rules`.
- **No edits during the deploy test gate.** One deploy at a time.
