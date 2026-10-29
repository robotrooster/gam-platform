-- 10/20 (Nic) — A PAY LINK IS AN INVOICE, AND ITS UTILITY LINE CLOSES OUT THE
-- BILL IT WAS RAISED FROM.
--
--   "Pay links should be kind of almost treated as if they were regular
--    invoices because it has the utilities and the rent on there. And a lot of
--    people that move out are going to get their final electric bill as a pay
--    link anyway. So the system needs to distinguish when a pay link is sent to
--    a person that it closes out that electric."
--
--   "to send somebody a pay link for their final bill, you would have to do it
--    through the point of sale, right? There's no way to just charge somebody
--    for electric when on move out... So it has to come from, or should be able
--    to come from, the point of sale as well. The point of sale is just an
--    extension of things."
--
--   Approved outright: "Paylink closes out electric. Yeah, do that. A utility
--   bill can be sent as a paylink, and a paylink's utility line settles the
--   bill and counts as recovery. Let's do that."
--
-- WHAT IS MISSING TODAY. Nothing joins a utility bill to a pay link in either
-- direction. A utility bill becomes a line on the resident's portal invoice,
-- which is no use at all to somebody who has moved out; and the register is the
-- only door in GAM that can email a person a charge for kilowatts. So the two
-- halves of a final electric bill live in rooms that cannot see each other, and
-- what actually happened at Mountain View is the proof: Andres Razo's August and
-- September power, $163.17, was rung up BY HAND on a pay link, paid in full on
-- 10/06 — and RV 27's submeter has no utility_bills row for those cycles, ever.
-- The money came in and no bill was ever closed by it.
--
-- WHY A TABLE AND NOT A COLUMN ON THE BILL. Three facts have to be recorded and
-- only one of them belongs to a bill:
--   1. which pay link was raised for which bill (a column on utility_bills
--      could carry this one);
--   2. that a utility line was collected for which somebody never cut a bill at
--      all — the Andres shape. There is no row to hang a column on, and
--      inventing a utility_bills row for usage nobody metered into a cycle
--      would be writing a bill that never existed, which is worse than the gap;
--   3. that both of those are the SAME kind of thing when the gap is counted:
--      utility money given back, per utility type, per space when a space is
--      known.
-- One book for all three, the way utility_absorbed_charges became the one book
-- for utility billed to NOBODY (10/20). The first report that has to add two
-- tables together is the day the number stops being trustworthy.
--
-- THE MATCH IS CARRIED, NEVER GUESSED. A link raised from a bill names the bill
-- on its line and in a row here. Nothing downstream ever has to pair a dollar
-- figure with the words "Electric (per kWh)" and hope: a fuzzy match on an
-- amount and an item name is not good enough for money, and the register's name
-- and category strings are exactly what the 10/20 propane work took out of the
-- money path (pos_items.recovers_utility).
--
-- NOT COUNTED TWICE, BY CONSTRUCTION. Where a bill exists, the BILL is the one
-- record of money billed back and of money collected — a row here with a
-- utility_bill_id adds no second figure, it only says how it was collected. A
-- row with no bill is the only kind that is itself a figure. The partial unique
-- indexes below make the double impossible rather than unlikely: one open link
-- per bill, and one settlement per bill ever.
--
-- EXPAND ONLY. One new table, nothing altered, no backfill (the only live case
-- is Andres's and it is a one-off proposed in the handoff, not run here).
-- Re-runnable.

CREATE TABLE IF NOT EXISTS utility_pay_link_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pay_link_id uuid NOT NULL REFERENCES pos_pay_links(id) ON DELETE RESTRICT,
  landlord_id uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
  property_id uuid NOT NULL REFERENCES properties(id) ON DELETE RESTRICT,

  -- The bill this line closes out, or NULL when there was never a bill behind
  -- it (a line rung up by hand for somebody's power — the Andres shape).
  utility_bill_id uuid REFERENCES utility_bills(id) ON DELETE RESTRICT,
  -- What it was for, as far as anyone knows. A bill-raised row has all three
  -- from its bill; a hand-rung row may have none of them, and NULL there means
  -- "nobody said", not zero.
  unit_id uuid REFERENCES units(id) ON DELETE RESTRICT,
  meter_id uuid REFERENCES utility_meters(id) ON DELETE RESTRICT,
  billing_cycle_month date,
  -- Which utility, from the bill or from the catalog item's own
  -- recovers_utility column — never from an item name or a category name.
  utility_type text NOT NULL,

  charge_amount numeric(12,2) NOT NULL,
  tax_amount numeric(12,2) NOT NULL DEFAULT 0,

  status text NOT NULL DEFAULT 'open',
  -- The sale the payment recorded, and the one line of it this row is. Both
  -- ON DELETE SET NULL for the same reason pos_transaction_items.item_id is:
  -- the money record outlives the catalog row it pointed at.
  pos_transaction_id uuid REFERENCES pos_transactions(id) ON DELETE SET NULL,
  pos_transaction_item_id uuid REFERENCES pos_transaction_items(id) ON DELETE SET NULL,
  -- The charge row on the payer's invoice that this collection took care of,
  -- kept after it is voided so the bill's whole story is readable: billed on
  -- invoice X, then collected on a pay link, and that charge voided so nobody
  -- was asked twice.
  payment_id uuid REFERENCES payments(id) ON DELETE SET NULL,

  settled_at timestamptz,
  refunded_at timestamptz,
  cancelled_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT upls_amount_check CHECK (charge_amount >= 0),
  CONSTRAINT upls_tax_check CHECK (tax_amount >= 0),
  -- Same six as @gam/shared UTILITY_TYPES and pos_items.recovers_utility.
  -- Deliberately wider than utility_bills' five: a delivered propane fill is a
  -- utility that can be collected this way the day stay billing is wired, and a
  -- CHECK that refuses it would refuse it silently at the till.
  CONSTRAINT upls_utility_type_check
    CHECK (utility_type = ANY (ARRAY['water','gas','electric','sewer','trash','propane'])),
  CONSTRAINT upls_status_check
    CHECK (status = ANY (ARRAY['open','settled','refunded','cancelled'])),
  -- Each stamp belongs to exactly one outcome, so a row cannot say two things.
  CONSTRAINT upls_settled_is_stamped
    CHECK ((settled_at IS NOT NULL) = (status = ANY (ARRAY['settled','refunded']))),
  CONSTRAINT upls_refunded_is_stamped CHECK ((refunded_at IS NOT NULL) = (status = 'refunded')),
  CONSTRAINT upls_cancelled_is_stamped CHECK ((cancelled_at IS NOT NULL) = (status = 'cancelled')),
  -- Money collected names the sale that collected it; nothing else does.
  CONSTRAINT upls_sale_shape
    CHECK ((pos_transaction_id IS NOT NULL) = (status = ANY (ARRAY['settled','refunded']))),
  -- A row with no bill behind it is only ever written by a payment landing, so
  -- it is never 'open' or 'cancelled' — there is nothing to hold open.
  CONSTRAINT upls_no_bill_means_a_sale
    CHECK (utility_bill_id IS NOT NULL OR status = ANY (ARRAY['settled','refunded']))
);

COMMENT ON TABLE utility_pay_link_settlements IS
  '10/20 (Nic): the one book for utility money collected on a PAY LINK — '
  '"a paylink''s utility line settles the bill and counts as recovery". One row '
  'per utility line on a link: with utility_bill_id, the bill that line closes '
  'out (the bill stays the record of what was billed back, so this row adds no '
  'second figure); without one, a line rung up by hand for somebody''s power '
  'that no bill was ever cut for — which is the only kind that is itself a '
  'figure, and is what happened to Andres Razo''s $163.17 of August and '
  'September electric. Which utility comes from the bill or from '
  'pos_items.recovers_utility, never from an item name.';

COMMENT ON COLUMN utility_pay_link_settlements.utility_bill_id IS
  'The utility bill this line settles, or NULL when there was never one. NULL is '
  'an answer — "collected, and no bill existed" — not a missing value: a bill '
  'invented after the fact for usage nobody read into a cycle would be a worse '
  'record than the gap it filled.';

COMMENT ON COLUMN utility_pay_link_settlements.payment_id IS
  'The charge row on the payer''s invoice that this collection took care of. The '
  'charge is VOIDED when the link is paid (services/chargeVoids — "a charge '
  'nobody owes is voided, never deleted"), because the money came in through the '
  'register sale and the charge accruing the same income twice would double the '
  'revenue in the books. Kept here after the void so the bill''s story stays '
  'readable.';

COMMENT ON COLUMN utility_pay_link_settlements.status IS
  'open (a link is out for this bill), settled (paid), refunded (the WHOLE sale '
  'went back, so the bill is owed again and this stops counting as recovery), '
  'cancelled (the link was closed before it was paid). A PART refund leaves the '
  'row settled with a note: short of the whole sale going back, nothing says '
  'which line the money came off, and re-billing the full amount would ask the '
  'payer for money the landlord is still holding.';

-- ONE OPEN LINK PER BILL. Two links out for one bill is two people asked for
-- the same money, and whichever is paid second lands as a payment GAM has to
-- hand back.
CREATE UNIQUE INDEX IF NOT EXISTS upls_one_open_link_per_bill
  ON utility_pay_link_settlements (utility_bill_id)
  WHERE status = 'open' AND utility_bill_id IS NOT NULL;

-- ONE SETTLEMENT PER BILL, EVER. This is the double-count guard with teeth: a
-- bill cannot be recorded as collected by two payments, so it can never be
-- counted as recovered twice. ('refunded' is left out on purpose — a refunded
-- attempt must not block collecting the bill again.)
CREATE UNIQUE INDEX IF NOT EXISTS upls_one_settlement_per_bill
  ON utility_pay_link_settlements (utility_bill_id)
  WHERE status = 'settled' AND utility_bill_id IS NOT NULL;

-- One row per sale line, so a replayed webhook records the same collection once.
CREATE UNIQUE INDEX IF NOT EXISTS upls_one_row_per_sale_line
  ON utility_pay_link_settlements (pos_transaction_item_id)
  WHERE pos_transaction_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS upls_by_link ON utility_pay_link_settlements (pay_link_id);
-- How the gap is read: a property's collections by utility and by cycle.
CREATE INDEX IF NOT EXISTS upls_by_property_cycle
  ON utility_pay_link_settlements (property_id, utility_type, billing_cycle_month);

-- The change journal is never pruned, and every table that holds money gets
-- the trigger in the migration that creates it (CLAUDE.md).
DROP TRIGGER IF EXISTS audit_utility_pay_link_settlements ON utility_pay_link_settlements;
CREATE TRIGGER audit_utility_pay_link_settlements
  AFTER DELETE OR UPDATE ON utility_pay_link_settlements
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
