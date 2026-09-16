-- S648: 20260916210000 dropped pos_transactions.payout_owed / payout_intent_id
-- while the running API build still read and wrote them (register sales and the
-- weekly batch). Restored so that build keeps working until the build that uses
-- held_payout_items is live; a later migration drops them again. Anything the
-- old build writes here meanwhile is copied into held_payout_items by that
-- migration, so no sale is lost.
ALTER TABLE pos_transactions
  ADD COLUMN IF NOT EXISTS payout_owed numeric(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payout_intent_id uuid REFERENCES platform_transfer_intents(id);
