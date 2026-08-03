# C4 — Live-fire money test (Stripe LIVE keys already wired, 7/21)

Goal: prove one real ACH + one real card charge flow end-to-end on LIVE Stripe
BEFORE any Oak Park tenant pays. Under the platform-holds model, money lands on
**GAM's platform balance** first, settles via webhook, then a weekly batch
transfers the landlord's share to their Connect account.

Use TINY amounts ($1–$5). This is real money.

## Prereqs
- [x] N1/C3 done — `sk_live`/`pk_live` + both `whsec_` secrets in `apps/api/.env`.
- [ ] **N4** — the test landlord's Stripe Connect KYC complete (`connect_charges_enabled=true`, `connect_details_submitted=true`). Without this the charge still succeeds (held on platform) but can't batch out.
- [ ] A **test tenant** on a real lease with a real payment method:
  - ACH: added via **Financial Connections** (real bank login) — live, not the dev mock SetupIntent.
  - Card: a real card (yours), small charge.
- [x] Prod webhook endpoint registered in the Stripe **live** dashboard →
  `https://api.goldassetmanagement.com/webhooks/stripe` (NOT `/api/webhooks/stripe`).
  VERIFIED 2026-08-02 via Stripe API: TWO live endpoints on that one URL, both `enabled` —
  the **platform** one (`we_1TvhBn…`, no application: payment_intent.*, charge.dispute.*,
  checkout.session.completed) verified against `STRIPE_WEBHOOK_SECRET`, and the **Connect**
  one (`we_1TwmXE…`, application `ca_Uweu…`: account.updated, payout.*) verified against
  `STRIPE_CONNECT_WEBHOOK_SECRET`. Handler tries both secrets (`src/routes/webhooks.ts:32-41`).
  Route enforces signature (POST returns 400, not 404). Prod API healthy 200 (local + tunnel).

## Test A — CARD (immediate proof)
1. As the test tenant, Pay Now a small rent (e.g. $2) with the real card.
2. **Stripe live dashboard** → Payments: PI shows `succeeded`, amount = rent + processing fee (S562 — tenant pays the fee on top).
3. **DB**: the `payments` row → `status='settled'`, `platform_held=true`, `stripe_payment_intent_id` set. Allocation ledger rows written (owner_share etc.).
4. **Webhook**: Stripe dashboard → the webhook event shows 200. (If not, sig-secret mismatch — fix `.env`, restart API.)
5. GAM keeps the processing-fee spread; the rest sits on the platform balance awaiting batch (Test C).

## Test B — ACH (start early; settles T+~4 biz days)
1. Same, small amount, ACH method. PI goes `processing` immediately, `succeeded` days later.
2. Verify the `processing` webhook lands + the row is `processing`/`platform_held=true` now; re-check for `settled` after ACH clears.
3. Because ACH is slow, **kick this off first** so it clears before launch.

## Test C — batch to the landlord (platform → Connect)
Don't wait for Tuesday's cron. Trigger `reconcilePlatformHeldPayments(landlordId)`
(`apps/api/src/services/landlordPassthrough.ts`) manually — a one-off ts-node
script like the C6 dry-run (import it, pass the test landlord id).
- Verify: a Stripe **Transfer** platform→landlord Connect for the owner_share; `platform_held` flips false; the landlord's Connect balance reflects it.
- Standard payout (Connect→bank) then lands ~T+2.

## Test D — refund / reversal
1. Refund the card charge from the Stripe dashboard (small, safe).
2. Confirm the refund lands and no reversal-recovery misfires (the reversal handler only acts on POST-settlement disputes/returns — a plain refund of a still-held charge should be clean). Watch `admin` notifications for anything unexpected.

## Pass criteria
- Card: charge succeeds, webhook 200, row settles, allocation correct, batch transfers to Connect, refund clean.
- ACH: charge processes, settles after clearing, same downstream.
- GAM nets only its fee/spread on every path; the landlord is never double-paid; no money stuck `platform_held` after the batch.

## Then → C5
Repeat the tenant half as a full **prod** invite→login→(add bank via Financial
Connections)→Pay Now walkthrough with a throwaway tenant + real inbox.
