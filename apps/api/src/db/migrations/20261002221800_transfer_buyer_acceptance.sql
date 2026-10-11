-- S655 (security): a property transfer needs the RECEIVING side's consent.
--
-- S605 built consent for the seller only: every owner of the selling company
-- confirms with an emailed code, and the last confirmation executed the sale
-- straight onto whatever account the typed email belonged to. The buyer was
-- never emailed, never asked, and had no screen to see or refuse it — while
-- the property, its leases and tenants' records, its deposit obligations and
-- GAM's monthly platform fee for its units all landed on them. A mistyped email
-- handed every tenant's data to an unrelated landlord.
--
-- Now a sale to another account names the buyer's LOGIN (to_user_id). The
-- buyer accepts with their own emailed code and chooses which of their
-- companies takes the property; to_landlord_id is filled in at that moment.
-- A move between two companies of the SAME account still names the receiving
-- company up front and needs no buyer step (buyer_accepted_at is stamped when
-- it is raised).
--
-- EXPAND ONLY. to_landlord_id becomes nullable; every row written so far has
-- it, and the code that ships with this keeps writing it for own-account moves.

ALTER TABLE property_transfer_requests
  ADD COLUMN IF NOT EXISTS to_user_id        uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS buyer_code        text,
  ADD COLUMN IF NOT EXISTS buyer_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS buyer_accepted_by uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE property_transfer_requests ALTER COLUMN to_landlord_id DROP NOT NULL;

-- A request always names its receiver one way or the other.
ALTER TABLE property_transfer_requests
  ADD CONSTRAINT property_transfer_requests_receiver_named
  CHECK (to_landlord_id IS NOT NULL OR to_user_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_transfer_request_to_user_pending
  ON property_transfer_requests (to_user_id) WHERE status = 'pending';

COMMENT ON COLUMN property_transfer_requests.to_user_id IS
  'S655: the buyer''s login for a sale to another account. NULL for a move between companies of the same account.';
COMMENT ON COLUMN property_transfer_requests.buyer_accepted_at IS
  'S655: when the receiving side accepted. Set at creation for a same-account move. Nothing executes without it.';
