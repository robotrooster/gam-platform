-- S648: a stay deposit is now a GAM charge held for the landlord; its
-- PaymentIntent is kept so a chargeback can find the booking (and the
-- landlord it was paid out to). No backfill: no deposit has been paid yet.
ALTER TABLE unit_bookings ADD COLUMN stripe_payment_intent_id text;
CREATE UNIQUE INDEX idx_unit_bookings_pi ON unit_bookings (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;
