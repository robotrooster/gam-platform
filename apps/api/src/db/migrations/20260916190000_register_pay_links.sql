-- S648 (Nic): charges for people who are not on a lease, paid by card from a
-- link.
--
--   "We need a way to generate an item, a charge and send it to a link so they
--    can pay by email... people that stay by the night or by the week... we
--    sell propane. A lot of people want to pay with card. People that want to
--    use the dump station, having the QR code for the dump station so people
--    can scan it, pay their bill."
--
-- A pay link is a register cart the customer pays later, on Stripe's own card
-- page. one_time: emailed to one person, closes when paid. standing: the same
-- item for anyone (the dump-station QR), stays open; every payment is its own
-- sale. The customer pays the usual card fee on top, as with rent. Paid →
-- recorded as an ordinary card sale (services/posSale), and a stay attached to
-- the link is confirmed on the schedule.
CREATE TABLE pos_pay_links (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token                      text NOT NULL UNIQUE,
  landlord_id                uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
  property_id                uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,
  created_by                 uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind                       text NOT NULL CHECK (kind IN ('one_time', 'standing')),
  label                      text NOT NULL,
  items                      jsonb NOT NULL,
  subtotal                   numeric(10,2) NOT NULL CHECK (subtotal >= 0),
  tax_amount                 numeric(10,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  discount_amount            numeric(10,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  total                      numeric(10,2) NOT NULL CHECK (total > 0),
  customer_name              text,
  customer_email             text,
  customer_phone             text,
  tenant_id                  uuid REFERENCES tenants(id) ON DELETE SET NULL,
  pos_customer_id            uuid REFERENCES pos_customers(id) ON DELETE SET NULL,
  booking_id                 uuid REFERENCES unit_bookings(id) ON DELETE SET NULL,
  status                     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid', 'cancelled', 'expired')),
  paid_at                    timestamptz,
  pos_transaction_id         uuid REFERENCES pos_transactions(id) ON DELETE SET NULL,
  last_checkout_session_id   text,
  expires_at                 timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pos_pay_links_one_time_has_email CHECK (kind <> 'one_time' OR customer_email IS NOT NULL)
);
CREATE INDEX idx_pos_pay_links_property_open ON pos_pay_links (property_id, created_at DESC) WHERE status = 'open';

-- Which link a card sale came from (a standing link has many).
ALTER TABLE pos_transactions ADD COLUMN IF NOT EXISTS pay_link_id uuid REFERENCES pos_pay_links(id) ON DELETE SET NULL;

CREATE TRIGGER audit_pos_pay_links AFTER DELETE OR UPDATE ON pos_pay_links
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
