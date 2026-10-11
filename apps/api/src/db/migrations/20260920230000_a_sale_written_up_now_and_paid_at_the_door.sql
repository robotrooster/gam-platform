-- S652: the register learns to park a sale.
--
-- Nic, describing propane delivery to people off the park — the RV park next
-- door, anybody in town who cannot get propane except from him:
--
--   "we would need to somehow create the tickets in the office because that's
--   where the dispenser is pumping propane and you have to reset the propane
--   counter before you can pump the next person. So we need a list of who the
--   tank belongs to and how many gallons went into it."
--
-- The register has only ever known one shape: ring it and take the money in the
-- same motion. That is right at a counter and wrong at a pump, because the two
-- halves happen in different places hours apart. The gallons are known in the
-- office, where the meter is and where it has to be zeroed before the next
-- tank; the money happens at somebody's door.
--
-- And it is not a pay link. Nic: "That's product actually out and payment needs
-- to be rendered right then instead of chasing somebody down later."
--
-- WHY THIS TABLE HOLDS NO MONEY. A ticket is a cart and a customer, nothing
-- more — no total, no tax, no fee. Those are computed by the same server path
-- every other sale uses at the moment it is rung, so a ticket written on Tuesday
-- and settled on Thursday cannot charge Tuesday's tax rate or miss a reprice.
-- The alternative, freezing a total at write-up time, is a second pricing
-- authority, and this session was largely spent deleting one of those.

CREATE TABLE IF NOT EXISTS pos_open_tickets (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  landlord_id     UUID NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  created_by      UUID NOT NULL REFERENCES users(id),
  -- Who it is for. Exactly one, the same XOR the register already enforces on a
  -- charge sale: a tenant is one of the account's residents, a POS customer is
  -- anybody else. (Nic: all tenants are customers, not all customers are
  -- tenants — a one-way valve.)
  tenant_id       UUID REFERENCES tenants(id),
  pos_customer_id UUID REFERENCES pos_customers(id),
  -- The cart, in the shape the register already posts: [{id, name, qty, price, tax}].
  -- `price` is carried for display only; the server reprices at settlement.
  items           JSONB NOT NULL,
  note            TEXT,
  status          TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'settled', 'voided')),
  settled_transaction_id UUID REFERENCES pos_transactions(id),
  settled_at      TIMESTAMPTZ,
  voided_at       TIMESTAMPTZ,
  void_reason     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT pos_open_tickets_one_customer CHECK (
    (tenant_id IS NOT NULL)::int + (pos_customer_id IS NOT NULL)::int = 1)
);

-- The driver's list: what is still owed at this property, oldest first.
CREATE INDEX IF NOT EXISTS pos_open_tickets_open_idx
  ON pos_open_tickets (property_id, created_at) WHERE status = 'open';

COMMENT ON TABLE pos_open_tickets IS
  'S652: a sale written up where the goods are measured and settled where the customer is. Holds no money — the total is computed at settlement by the same path every register sale uses.';

-- The sale that settled a ticket points back at it, so a till count can tell a
-- delivered ticket from a walk-up without joining through a nullable column on
-- the ticket side.
ALTER TABLE pos_transactions
  ADD COLUMN IF NOT EXISTS open_ticket_id UUID REFERENCES pos_open_tickets(id);
