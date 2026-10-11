-- S648: the build that records register sales in held_payout_items is live, so
-- the placeholder columns kept for the previous build (20260916210500) go.
-- Anything that build wrote meanwhile is copied across first (0 rows at the
-- time of writing).
INSERT INTO held_payout_items (landlord_id, source_type, source_id, amount, payout_intent_id, created_at)
SELECT landlord_id, 'pos_sale', id::text, payout_owed, payout_intent_id, created_at
  FROM pos_transactions WHERE payout_owed > 0
ON CONFLICT (source_type, source_id) DO NOTHING;
ALTER TABLE pos_transactions DROP COLUMN payout_owed, DROP COLUMN payout_intent_id;
