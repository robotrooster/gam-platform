-- THE TWO FEES FOR MOVING A FLEXDEPOSIT (10/27, Nic).
--
-- A resident with a deposit in GAM custody moves to another unit. Where the
-- new unit's deposit is larger, the difference is a TOP-UP, and Nic set two
-- routes for it:
--
--   "i told you two things because there are 2 routes. a route for splitting
--    the top up into payments and a route where its collected in single
--    payment."
--
--   PAID IN FULL   one pull for the whole difference. Nothing is split, so the
--                  bracket grid — which prices SPLITTING — never comes into it.
--                  One flat fee covers the move: $25.
--
--   SPLIT 2 or 4   a real plan on the top-up amount, priced from
--                  flexdeposit_fee_schedule on the bracket the TOP-UP falls in
--                  ("most people's top up, if anything, will fall in that under
--                  $1,000 category" — $48 on 2, $67 on 4), plus $5 to record
--                  the movement against the new landlord's books.
--
-- Nic on why the $5 is worth charging rather than absorbing: "The $5 fee for
-- recording it against the new landlord's books is cheaper than the money
-- going out to them and then the $6 coming back in for the payment ... or the
-- 3% of Stripe's card processing fee." The ACH or card cost of collecting is a
-- SEPARATE pass-through line either way — "that's not including any banking
-- fees. ACH pull for that collection would still be on there as a separate
-- line item."
--
-- WHY NOT A PERCENTAGE. Nic floated 3% of the top-up and asked what I thought.
-- It is the one shape that breaks the structure: a charge scaling with the
-- amount of money reads as a charge FOR the money — he killed the same idea for
-- FlexPay himself ("that makes it look like an origination charge"), and on a
-- top-up paid in full it is worse, because nothing is financed and a percentage
-- of funds moved is how a money transmitter prices. It also underprices the
-- small ones below GAM's own cost: 3% of a $100 top-up is $3 against a $6 ACH
-- pull. Flat for the single pull, the existing grid for a split.
--
-- FLAT, SO THEY GET THEIR OWN TABLE: the Flex grids are bracketed on an amount
-- and these are not. Effective-dated like the grids, so a re-price APPENDS a
-- row with a forward date instead of editing the one people have been charged
-- against. 2020-01-01 for the first schedule, for the same reason the grids
-- use it: a schedule dated later than the move being priced resolves to no
-- price at all, and a missing price is an error, never a zero.

CREATE TABLE IF NOT EXISTS flexdeposit_move_fee_schedule (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- One pull for the whole top-up. Nothing split, one fee, no movement fee on
  -- top ("one fee, flat, $25. Not two fees" — agreed 10/27).
  paid_in_full_fee   NUMERIC(10,2) NOT NULL,
  -- Charged BESIDE the grid's split price when the top-up goes on a plan.
  split_movement_fee NUMERIC(10,2) NOT NULL,
  effective_from     DATE NOT NULL,
  note               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT flexdeposit_move_fee_nonneg CHECK (paid_in_full_fee >= 0 AND split_movement_fee >= 0),
  CONSTRAINT flexdeposit_move_fee_one_per_date UNIQUE (effective_from)
);

INSERT INTO flexdeposit_move_fee_schedule
  (paid_in_full_fee, split_movement_fee, effective_from, note)
SELECT 25.00, 5.00, DATE '2020-01-01',
       '10/27 Nic: $25 to collect a top-up in one pull; $5 to record the movement when it is split.'
 WHERE NOT EXISTS (SELECT 1 FROM flexdeposit_move_fee_schedule);

COMMENT ON TABLE flexdeposit_move_fee_schedule IS
  'What moving a FlexDeposit custody balance to a new unit costs (10/27, Nic): one flat fee when the top-up is collected in a single pull, or a smaller movement fee charged beside the grid price when it is split into 2 or 4. Effective-dated; a re-price appends a forward-dated row. The ACH or card cost of collecting is a separate pass-through.';
