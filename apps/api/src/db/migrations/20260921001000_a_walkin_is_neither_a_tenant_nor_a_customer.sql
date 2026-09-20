-- S652: a ticket may name a BOOKING instead of a person.
--
-- pos_open_tickets was built for propane: somebody in town, or the RV park next
-- door, who is a POS customer — or a resident, who is a tenant. Exactly one of
-- the two, which is the XOR the register already enforces on a charge sale.
--
-- A walk-in reservation is neither. Nic: "RVs are, a lot of people just show
-- up, hey, can I get a night or two nights." That person has no account of any
-- kind and does not need one to hand over cash for two nights — the booking
-- already carries their name, phone and email, which is precisely what the
-- guest columns on unit_bookings are for. Minting a POS customer record to
-- satisfy a constraint would litter every park's customer list with one-night
-- strangers, and Nic's rule is the other direction: all tenants are customers,
-- not all customers are tenants — not "everyone who ever paid is a customer".
--
-- So the rule becomes: a ticket must say WHO it is for, and a booking is a
-- perfectly good answer. Still at most one person named, so nothing can be
-- ambiguous about who owes it.

ALTER TABLE pos_open_tickets DROP CONSTRAINT IF EXISTS pos_open_tickets_one_customer;
ALTER TABLE pos_open_tickets ADD CONSTRAINT pos_open_tickets_one_customer CHECK (
  (tenant_id IS NOT NULL)::int + (pos_customer_id IS NOT NULL)::int
    + (booking_id IS NOT NULL)::int >= 1
  AND (tenant_id IS NOT NULL)::int + (pos_customer_id IS NOT NULL)::int <= 1
);
