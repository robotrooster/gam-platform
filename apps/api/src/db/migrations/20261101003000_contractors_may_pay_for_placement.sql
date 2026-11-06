-- Contractors may pay for the top spot. Being listed stays free.
--
-- 10/31, earlier the same evening, Nic said: "Contractors are on the platform
-- for free... Angie's List charges people for leads. We don't want to charge
-- that." I read that as "no listing fee, ever" and pinned contractors.listing_tier
-- and contractors.listing_fee to NULL with a CHECK so a later session could not
-- quietly start charging.
--
-- Asked directly, he corrected me: "i meant they didnt have to pay to play but
-- they can. top spot paid but listed free." And, in the same breath: "maybe we
-- have per trade, split it up per trade or per service and have a paid section.
-- A contractor can pay to be at the top of the list in the area... contractors
-- can pay to be at the top of their bid in, like, maybe per zip code."
--
-- So the rule the CHECK encoded was too strong, and this drops it. The rule
-- that actually holds is narrower and is NOT expressible as a column
-- constraint: **nobody is ever charged to be findable, or charged for a lead.**
-- Position is a product; presence is not. A contractor who pays nothing still
-- appears in the directory and may still bid on every open job.
--
-- These two columns stay unused. Paid placement is per trade and per zip with
-- its own dates and its own price card, which is a table, not two columns on
-- the contractor — the same shape as every other GAM price
-- ([[gam-flex-fees-live-in-db-price-cards]]). Writing a fee here would make a
-- contractor's placement a property of the contractor rather than of the
-- placement, and there would be nowhere to put "top of plumbing in 85201 for
-- November".
--
-- No backfill needed: zero rows.

ALTER TABLE contractors DROP CONSTRAINT IF EXISTS contractors_no_listing_fee;

COMMENT ON COLUMN contractors.listing_tier IS
  'Unused. From an abandoned 2026 directory idea. Paid placement is per trade and per zip in its own table with its own price card, not a column here — see migration 20261101003000.';
COMMENT ON COLUMN contractors.listing_fee IS
  'Unused. See listing_tier. Nobody is ever charged to be findable or charged for a lead; only position is sold.';
