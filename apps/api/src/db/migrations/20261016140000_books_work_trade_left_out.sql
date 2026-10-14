-- 10/14 (Nic, after asking his bookkeeper: "she doesn't keep track of
-- workers, just the paying customers"): a third answer to how work-trade
-- hours that cover rent count in the books, 'left_out' — only money paid
-- counts; the hours take the bill back off the income it was charged to.
-- Expand only: the rule now allows one more value.
ALTER TABLE landlords DROP CONSTRAINT IF EXISTS landlords_books_work_trade_method_check;
ALTER TABLE landlords
  ADD CONSTRAINT landlords_books_work_trade_method_check
    CHECK (books_work_trade_method IS NULL OR books_work_trade_method IN ('rent_and_labor', 'rent_discount', 'left_out'));
