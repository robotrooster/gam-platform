-- FlexDeposit offers TWO choices: split into 2, or split into 4. Nothing else,
-- and the same price for everybody.  (10/26, Nic.)
--
-- WHY THIS SHAPE IS THE POINT, NOT A SIMPLIFICATION.
--
--   "The same amount of installments at the same amount of security deposit
--    needs to be the same price for everybody. That's what keeps it not
--    lending. It's a service they're paying for. It's like window tinting. The
--    more windows you have on a car, the more money you're going to pay. It
--    doesn't matter what type of car it is. Six windows on any car is going to
--    be the same no matter what the car is."
--
-- And on dropping the variable installment count:
--
--   "Why don't we just make every bracket four payments? If they need six,
--    that's too much. And two might not be enough... That way there's no
--    adverse anything. People don't have a choice. There's no 'in part' by
--    limiting their options. It's only based on their rent, which is not set
--    by us."
--
-- That is the structural argument, and it is a good one. Every mechanism that
-- gave one applicant fewer options than another was a risk-based decision on
-- the applicant, which is what makes something look like a credit decision --
-- and under FCRA an adverse action need only rest "in part" on such
-- information. Remove the variation and there is nothing to be adverse about:
-- the price is a function of the deposit and the number of installments, both
-- of which the applicant can see and neither of which GAM sets about them.
--
-- THE RE-MAP, in his words: "just take the 6 installment price and make that
-- the price at the 4 installment column, and make the 4 installment column the
-- price at the 2 installment column."
--
--   deposit bracket    2 payments   4 payments
--   under $1,000           48           67
--   $1,000-1,499           67           93
--   $1,500-1,999           86          120
--   $2,000-2,499          105          147
--   $2,500-2,999          124          173
--   $3,000 and up      NOT OFFERED
--
-- He checked the first row himself against the move-in at Country Acres: "they
-- are either going to see a $48 fee on 2 payments for the deposit to be split,
-- or a $67 fee for the deposit to be split into 4 payments."
--
-- The whole fee is still collected with installment 1 either way.
--
-- The rows for 3, 5 and 6 payments GO, so no code path can quote a count the
-- product does not sell. The CHECK is narrowed to (2, 4) for the same reason:
-- a price that cannot be offered should not be representable.
--
-- Same supersede-in-place as the evening's other drafts: nothing has ever been
-- priced from this table, and FlexDeposit's first enrollment is tomorrow.
-- No backfill needed -- there are zero FlexDeposit plans.

-- 2-payment price becomes what 4 payments cost; 4-payment becomes what 6 cost.
UPDATE flexdeposit_fee_schedule d
   SET fee = src.fee,
       note = '10/26 final (Nic) — two choices only; same price for everybody at a given deposit'
  FROM flexdeposit_fee_schedule src
 WHERE src.deposit_min = d.deposit_min
   AND src.effective_from = d.effective_from
   AND ((d.payments = 2 AND src.payments = 4) OR (d.payments = 4 AND src.payments = 6));

DELETE FROM flexdeposit_fee_schedule WHERE payments IN (3, 5, 6);

ALTER TABLE flexdeposit_fee_schedule DROP CONSTRAINT IF EXISTS flexdeposit_fee_schedule_payments_check;
ALTER TABLE flexdeposit_fee_schedule
  ADD CONSTRAINT flexdeposit_fee_schedule_payments_check CHECK (payments IN (2, 4));

COMMENT ON TABLE flexdeposit_fee_schedule IS
  'FlexDeposit service fee by deposit bracket and installment count. Exactly two counts are sold, 2 and 4 (10/26, Nic), at the SAME price for everybody at a given deposit size — that uniformity is what keeps it a service price rather than a credit decision. Not offered at $3,000 or more. Re-pricing appends a row with a later effective_from.';
