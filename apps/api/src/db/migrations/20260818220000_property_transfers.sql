-- S605 (Nic): sale of a property — transfer the account, not the money.
--
-- "It's more about just transferring ownership of the property account and the
-- record of deposits and leases and stuff like that. I think we're
-- overcomplicating this." Correct: the closing contract settles the money via a
-- credit at closing, so GAM moves no funds and computes no proration. What GAM
-- owns is WHO the property, its tenancies and its obligations belong to from the
-- transfer date, and where rent is routed afterwards.
--
-- WHAT MOVES — live state the new owner is now responsible for:
--   properties, units, leases, security deposits, equipment, open maintenance.
--
-- WHAT STAYS — settled financial history:
--   payments, invoices, disbursements, expenses, platform-fee accruals, other
--   income. These record who was actually paid, and rewriting them would
--   falsify the past. The old owner's books for the period they owned it stay
--   intact and reportable; the new owner's begin at the transfer.
--
-- Leases move UNCHANGED. Most states oblige a buyer to honour the remaining
-- term, and re-papering a sitting tenant's lease at a sale would be both wrong
-- and alarming to them.
--
-- Rent routing re-points automatically: payouts resolve through
-- leases/units/properties.landlord_id, so moving those is what sends the next
-- rent to the buyer's Connect account.
--
-- This table is the audit record — permanent, per the retention rule, and the
-- answer to "why did this property change hands on the 14th?".

CREATE TABLE IF NOT EXISTS property_transfers (
  id                 uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  property_id        uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  from_landlord_id   uuid NOT NULL REFERENCES landlords(id),
  to_landlord_id     uuid NOT NULL REFERENCES landlords(id),
  transferred_at     timestamptz NOT NULL DEFAULT now(),
  transferred_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  -- What actually moved, for the record: counts per table at the moment of sale.
  moved              jsonb NOT NULL DEFAULT '{}'::jsonb,
  note               text,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_property_transfers_property
  ON property_transfers (property_id, transferred_at DESC);
CREATE INDEX IF NOT EXISTS idx_property_transfers_to
  ON property_transfers (to_landlord_id);

COMMENT ON TABLE property_transfers IS
  'S605: record of a property sale. Live state (units, leases, deposits, equipment) moved to the buyer; settled financial history stayed with the seller. No funds move — the closing contract handles proration.';
