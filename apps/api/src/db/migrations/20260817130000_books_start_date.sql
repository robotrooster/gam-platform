-- S605 (Nic): "books start date" — stop pre-onboarding bank history landing in
-- the review queue.
--
-- Linking a bank pulls everything Stripe has. Oak Park's first sync imported 112
-- transactions going back to February — six months of spending from before GAM
-- existed for them, every row sitting in "needs review". Nic: "when a landlord
-- wants to onboard, say, October first or September first, do we wanna offer the
-- option to not count previous transactions from the bank in the ledger?"
--
-- Yes. Anything posted before this date is still IMPORTED (GAM never discards
-- data, and the landlord may want the history later) but lands as `ignored`
-- rather than `needs_review`, so the queue only contains what belongs in their
-- GAM-era P&L.
--
-- Landlord-level, not per-connection: "my books start here" is a property of the
-- business, and a landlord who links a second bank later expects the same
-- cutoff without setting it twice.
--
-- NULL = no cutoff (import everything for review), which is the pre-S605
-- behaviour, so existing connections are unchanged until a date is chosen.

ALTER TABLE landlords
  ADD COLUMN IF NOT EXISTS books_start_date date;

COMMENT ON COLUMN landlords.books_start_date IS
  'S605: bank transactions posted before this date are imported but auto-ignored, keeping pre-GAM history out of the review queue and the P&L. NULL = no cutoff.';

-- The sync path filters on it per landlord; the review queue filters on status.
CREATE INDEX IF NOT EXISTS idx_bank_transactions_landlord_status_posted
  ON bank_transactions (landlord_id, status, posted_date DESC);
