-- ACH fee → flat $6 (S601, Nic; supersedes 20260810200000_ach_fee_flat_three).
--
-- WHY: the intermediate "0.5% + $3" schedule was over-engineered. Nic's call: one
-- FLAT $6 bank fee at any rent — simple to state honestly ("$6 flat bank fee"), no
-- percentage to mislead a tenant. GAM nets $3-$6 after Stripe's cost (0.5% capped $3):
-- $3 at the top, more on lower rent. Tiny payments rarely go ACH (a card is cheaper at
-- that size). Mirrors PROCESSING_FEES in packages/shared. Card is untouched.
--
-- Append-only (keep-everything): expire the current ACH row, insert the flat-$6 one;
-- allocation.fetchActiveProcessingRate reads effective_until IS NULL.

UPDATE platform_processing_rates
   SET effective_until = now()
 WHERE payment_method = 'ach' AND effective_until IS NULL;

INSERT INTO platform_processing_rates
  (payment_method, customer_facing_flat, customer_facing_percent, customer_facing_cap,
   stripe_cost_flat, stripe_cost_percent, stripe_cost_cap, effective_from, notes)
VALUES
  ('ach', 6.00, 0.0000, 6.00, 0.0000, 0.5000, 3.00, now(),
   'S601 (Nic): ACH is a FLAT $6 customer fee at any rent. GAM nets $3-$6 after Stripe cost (0.5% capped $3). Simple to state; tiny payments use a card instead.');
