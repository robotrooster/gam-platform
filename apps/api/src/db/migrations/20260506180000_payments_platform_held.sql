-- S113-PhaseA: rent safety valve. When a landlord's Stripe Connect
-- account isn't payout-eligible at rent-charge time, the destination
-- charge model breaks (Stripe rejects PaymentIntents with
-- transfer_data.destination pointing at a non-charges_enabled account).
--
-- Pre-S113 behavior was a 409 throw — tenant told to retry later. Risk:
-- if rent collection fails repeatedly, tenants spend the rent money.
-- New behavior: when destination not ready, fire a standard charge to
-- GAM's platform balance and mark the payment platform_held=true.
--
-- A separate reconciliation flow (services/landlordPassthrough.ts) fires
-- a Transfer from platform → landlord Connect when the landlord's
-- Connect transitions to charges_enabled, paying out the accumulated
-- owner_share for all platform_held payments.
--
-- The signup flow gates landlord Connect onboarding; this column exists
-- to handle the rare case a property's landlord lost charges_enabled
-- (KYC issue / fraud flag) after onboarding completed.

ALTER TABLE payments
  ADD COLUMN platform_held boolean NOT NULL DEFAULT false;

-- Reconciliation queries find platform_held payments per landlord; partial
-- index keeps it small (most rows are not platform_held).
CREATE INDEX idx_payments_platform_held_landlord
  ON payments(landlord_id)
  WHERE platform_held = true;
