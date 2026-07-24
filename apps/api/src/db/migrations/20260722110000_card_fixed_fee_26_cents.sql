-- S552 (Nic): card fixed fee 10¢ → 26¢, mirroring the Stripe IC+ contract's
-- fixed per-transaction cost (interchange + 0.7% + $0.26) exactly.
--
-- WHY: with a 10¢ pass-through against a 26¢ contractual fixed cost, every
-- card transaction lost 16¢ on the fixed side — only covered by the
-- percentage spread on larger charges; small charges (screenings ~$36) were
-- net-negative. Matching the contract's 26¢ makes every transaction size
-- fee-neutral-or-positive and the customer-facing story exact: "26¢ is our
-- processor's per-transaction cost, passed through."
--
-- Cost-side columns updated to the real IC+ shape (0.26 fixed; percent =
-- 0.7% Stripe + ~2.2% market interchange blend — an ESTIMATE for spread
-- reporting only; actual interchange varies per card).
--
-- Single source: packages/shared PROCESSING_FEES (CARD_FLAT 0.26) — these
-- rows MUST match it. No backfill needed: rates read at charge time.

UPDATE platform_processing_rates
   SET customer_facing_flat = 0.26,
       stripe_cost_flat     = 0.26,
       stripe_cost_percent  = 2.90,
       notes = 'S552 schedule: 3.25% + $0.26/txn customer-facing (fixed mirrors IC+ contract). Cost side = 0.7% + $0.26 + ~2.2% interchange estimate.'
 WHERE payment_method = 'card' AND effective_until IS NULL;
