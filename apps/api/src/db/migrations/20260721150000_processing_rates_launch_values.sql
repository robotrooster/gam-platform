-- S551 (Nic): lock in the platform-wide processing fee schedule.
--
-- WHY: the platform_processing_rates rows have been NULL placeholders since
-- seed ("Set rates before enabling rent allocation") — the allocation engine
-- 503s on them, which would have blocked the first live rent payment. Nic
-- locked the customer-facing schedule today:
--   Card: 3.25% + $0.10 per transaction   (S551 — the dime is new; the
--         pre-S551 model was 3.25% flat)
--   ACH:  1.0% capped at $6.00
-- Single source: packages/shared PROCESSING_FEES — these values MUST match
-- it. If the schedule ever changes, update shared and cut a new migration.
--
-- Cap columns are added here too (inseparable from the values: the ACH row
-- is wrong without its $6 cap, and the engine needs somewhere to read it).
-- NULL cap = uncapped. No backfill needed beyond the two UPDATEs below —
-- the table's only rows are the two placeholders.
--
-- Stripe-cost side is our blended cost estimate for spread reporting only
-- (card 2.9% + $0.30; ACH 0.5% capped $3.00 per Stripe pricing); it never
-- touches what a customer pays.

ALTER TABLE platform_processing_rates
  ADD COLUMN customer_facing_cap numeric(10,2),
  ADD COLUMN stripe_cost_cap     numeric(10,2);

UPDATE platform_processing_rates
   SET customer_facing_flat    = 0.10,
       customer_facing_percent = 3.25,
       customer_facing_cap     = NULL,
       stripe_cost_flat        = 0.30,
       stripe_cost_percent     = 2.90,
       stripe_cost_cap         = NULL,
       notes = 'S551 launch schedule: 3.25% + $0.10/txn customer-facing. Cost side = blended estimate.'
 WHERE payment_method = 'card' AND effective_until IS NULL;

UPDATE platform_processing_rates
   SET customer_facing_flat    = 0.00,
       customer_facing_percent = 1.00,
       customer_facing_cap     = 6.00,
       stripe_cost_flat        = 0.00,
       stripe_cost_percent     = 0.50,
       stripe_cost_cap         = 3.00,
       notes = 'S551 launch schedule: 1.0% capped $6.00 customer-facing. Cost side = Stripe ACH 0.5% capped $3.'
 WHERE payment_method = 'ach' AND effective_until IS NULL;
