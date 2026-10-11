-- S652 (Nic): card readers for landlords who take cards in person.
-- "They get their card reader, they plug it in, they're good to go." A landlord
-- asks for the ONE reader GAM supports from the register; GAM orders it from
-- Stripe's shop pre-registered to the property's Terminal location and ships
-- it straight to them; the price is paid off in monthly pieces netted from
-- their disbursements, each piece its own line.
CREATE TABLE IF NOT EXISTS pos_reader_orders (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id               uuid NOT NULL REFERENCES landlords(id),
  property_id               uuid NOT NULL REFERENCES properties(id),
  status                    text NOT NULL DEFAULT 'requested'
                            CHECK (status IN ('requested','ordered','shipped','delivered','registered','cancelled')),
  model                     text NOT NULL,
  price                     numeric(10,2) NOT NULL,
  installments              integer NOT NULL DEFAULT 1 CHECK (installments >= 1),
  installment_amount        numeric(10,2) NOT NULL,
  installments_raised       integer NOT NULL DEFAULT 0,
  ship_name                 text NOT NULL,
  ship_company              text,
  ship_line1                text NOT NULL,
  ship_line2                text,
  ship_city                 text NOT NULL,
  ship_state                text NOT NULL,
  ship_zip                  text NOT NULL,
  ship_phone                text,
  ship_email                text,
  note                      text,
  stripe_hardware_order_id  text,
  serial                    text,
  tracking_url              text,
  stripe_reader_id          text,
  requested_by_user_id      uuid REFERENCES users(id),
  ordered_at                timestamptz,
  shipped_at                timestamptz,
  delivered_at              timestamptz,
  registered_at             timestamptz,
  cancelled_at              timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pos_reader_orders_landlord_idx ON pos_reader_orders(landlord_id, status);

-- The device's monthly piece is its own kind of charge, so a landlord sees
-- "card reader, 2 of 4" and never a lump they can only dispute.
ALTER TABLE landlord_gam_charges DROP CONSTRAINT IF EXISTS landlord_gam_charges_kind_check;
ALTER TABLE landlord_gam_charges ADD CONSTRAINT landlord_gam_charges_kind_check
  CHECK (kind = ANY (ARRAY['subscription'::text, 'manual_payment_fee'::text, 'bank_debit_cost'::text, 'device_installment'::text]));
