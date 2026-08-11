-- ACH fee model → flat $3 GAM margin at any rent (S601, Nic).
--
-- WHY: the ACH customer fee was 1.0% capped $6, which nets GAM $3 only at the cap
-- (rent ≥ $600). Below that the margin was 0.5% of rent (< $3) — a Midwest $200
-- lot-rent ACH earned GAM only ~$1. This ACH revenue is a deliberate stream that
-- subsidizes the flat $2/occupied-unit landlord price, so the low end matters.
--
-- New schedule: customer fee = 0.5% (Stripe pass-through) + $3 flat, capped $6, so
-- GAM nets a FLAT $3 on every ACH at any rent. The Stripe cost side (0.5% capped $3)
-- is unchanged, so the $3 margin holds right up to and at the $6 cap. Only sub-$600
-- rent changes; everything >= $600 already paid $6 / netted $3. Mirrors PROCESSING_FEES
-- in packages/shared. Card is untouched.
--
-- Append-only (keep-everything): expire the current ACH row (effective_until=now) and
-- insert the new one; allocation.fetchActiveProcessingRate reads effective_until IS NULL.

UPDATE platform_processing_rates
   SET effective_until = now()
 WHERE payment_method = 'ach' AND effective_until IS NULL;

INSERT INTO platform_processing_rates
  (payment_method, customer_facing_flat, customer_facing_percent, customer_facing_cap,
   stripe_cost_flat, stripe_cost_percent, stripe_cost_cap, effective_from, notes)
VALUES
  ('ach', 3.00, 0.5000, 6.00, 0.0000, 0.5000, 3.00, now(),
   'S601 (Nic): ACH customer fee = 0.5% + $3 flat, capped $6 -> GAM nets a flat $3/txn at any rent. Fixes sub-$600 low end (was 1.0%-only, netting <$3). Stripe cost side unchanged (0.5% capped $3).');
