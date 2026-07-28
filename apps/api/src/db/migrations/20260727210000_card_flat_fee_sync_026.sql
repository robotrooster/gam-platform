-- S561 (Nic): sync the DB card processing flat fee to the S552 value.
--
-- WHY: packages/shared PROCESSING_FEES.CARD_FLAT was raised $0.10 → $0.26 in
-- S552 (the 26¢ mirrors the IC+ contract's fixed per-transaction cost), but the
-- matching migration was never cut, so platform_processing_rates.card still
-- seeds the stale S551 $0.10. The allocation engine reads the DB row (not the
-- shared constant), so the LIVE customer-facing card flat has been $0.10 —
-- undercharging $0.16 per card transaction vs. the locked $0.26. This forward
-- migration brings the active card row into agreement with the single source.
-- ACH row unchanged. No backfill needed.

UPDATE platform_processing_rates
   SET customer_facing_flat = 0.26,
       notes = 'S552 (via S561 sync): card 3.25% + $0.26/txn customer-facing (26¢ = IC+ fixed cost). Cost side = blended estimate.'
 WHERE payment_method = 'card' AND effective_until IS NULL;
