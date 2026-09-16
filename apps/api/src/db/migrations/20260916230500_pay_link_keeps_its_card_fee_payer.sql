-- S648: a pay link's amount is fixed when it is sent. Who pays the card fee is
-- captured then too, so changing the property setting later never changes what
-- an already-sent link (or a printed dump-station QR) charges. Existing links
-- were all created when the customer always paid.
ALTER TABLE pos_pay_links
  ADD COLUMN card_fee_payer text NOT NULL DEFAULT 'customer'
    CHECK (card_fee_payer IN ('customer', 'landlord'));
