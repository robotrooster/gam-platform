-- A DEPOSIT OVER THE TOP OF THE GRID IS SERVED, NOT REFUSED (10/27, Nic).
--
-- The table comment said "Not offered at $3,000 or more", which was the rule
-- on 10/26 and is not the rule now:
--
--   "We don't do deposits over $3,000. So that means if somebody's splitting a
--    payment more than that ... say the payment's $4,000 for the deposit. They
--    can split the $3,000 into four payments, they pay the $167 or whatever the
--    fee is, for the four payments, they pay the first payment of the $3,000,
--    so $750, and then they pay the difference of that $1,000 gap from $3,000
--    to $4,000 all at once."
--
-- So the plan covers the CEILING and the remainder is collected in full with
-- payment 1. The brackets themselves are untouched — still half-open, still an
-- error and never a zero when one is missing. What changed is one stated rule
-- ABOVE the top of the table (services/flexFees flexDepositSplit), and the
-- ceiling is READ from this table rather than written in code, so adding a
-- $3,000-3,499 bracket one day moves the cap by itself.
--
-- Comment only. No data, no structure.

COMMENT ON TABLE flexdeposit_fee_schedule IS
  'FlexDeposit service fee by deposit bracket and installment count. Exactly two counts are sold, 2 and 4 (10/26, Nic), at the SAME price for everybody at a given deposit size — that uniformity is what keeps it a service price rather than a credit decision. A deposit at or above the top bracket''s ceiling is served at the ceiling''s price (10/27): the plan splits the ceiling and the remainder is collected in full with payment 1. Re-pricing appends a row with a later effective_from.';
