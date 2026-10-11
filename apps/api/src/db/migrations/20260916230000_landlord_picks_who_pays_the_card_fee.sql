-- S648 (Nic): "landlord can choose to absorb the processing cost. We are
-- charging it as a platform to somebody. Landlord chooses whether they pass
-- through on the booking site or point of sale, or they just price accordingly."
--
-- GAM's card fee is charged on every card payment either way; these say who
-- pays it, per property:
--   customer — added on top of what the customer pays (the default; today's behavior)
--   landlord — the customer pays the price, the fee comes out of the payout
-- register_card_fee_payer covers the counter reader and emailed/QR pay links;
-- booking_card_fee_payer covers stay deposits on the booking site. Rent is not
-- covered here: a tenant paying rent by card always pays the fee.
ALTER TABLE properties
  ADD COLUMN register_card_fee_payer text NOT NULL DEFAULT 'customer'
    CHECK (register_card_fee_payer IN ('customer', 'landlord')),
  ADD COLUMN booking_card_fee_payer text NOT NULL DEFAULT 'customer'
    CHECK (booking_card_fee_payer IN ('customer', 'landlord'));
