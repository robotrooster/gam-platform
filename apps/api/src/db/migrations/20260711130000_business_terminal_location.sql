-- S536 (Nic): ALL money flows through GAM. Business terminal charges
-- become platform destination charges (GAM = merchant of record, gross
-- routed to the business's Connect balance, GAM's fee via
-- application_fee_amount, Friday-batched payouts like landlords).
-- Platform-account readers require a Stripe Terminal Location; one is
-- created per business from its address on first reader pairing.
-- No backfill needed (set on first pairing).
ALTER TABLE businesses ADD COLUMN stripe_terminal_location_id TEXT;
