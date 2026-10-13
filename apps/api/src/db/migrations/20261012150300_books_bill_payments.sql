-- 10/11 (Nic) — GAM BOOKS: EVERY BILL PAYMENT IS ITS OWN ROW, ON ITS OWN DAY
--
-- A bill kept one running amount_paid and one paid_at, and paid_at was set only
-- when the bill was paid off. The Cash Flow report read bills by paid_at, so a
-- bill paid in parts showed no money going out until the last part — and then
-- the whole amount, all on that last day. A $1,000 bill paid $400 in March and
-- $600 in May read as $0 in March and $1,000 in May.
--
-- Now POST /books/bills/:id/pay writes one row here per payment, on the day it
-- was made, in the same transaction that moves the bill's amount_paid and the
-- vendor's balances. Cash Flow reads money out for bills from this table.
--
--   amount         what the payment put toward this bill
--   vendor_credit  an overpayment the person confirmed, kept as the vendor's
--                  credit (books_vendors.credit_balance, S413). The money left
--                  the bank, so Cash Flow counts it too.
--   source         'payment' — recorded by the pay route as it happened
--                  'backfill' — rebuilt below from a bill paid before 10/11
--                  (BOOKS_BILL_PAYMENT_SOURCES in packages/shared)
--
-- Backfill: one 'backfill' row per bill already paid something, for its whole
-- amount_paid, dated the day it was paid off (paid_at). A bill only partly paid
-- has no record of its parts or their days; its row is dated the bill's last
-- change (updated_at), the best day known, and is marked 'backfill' so it can
-- be told apart. Production had 0 bills on 10/12 (read-only count).
--
-- Order: this runs before the code that writes payment rows ships, so a bill
-- paid in between (old pay route) gets no row here. The readers close that gap
-- themselves (routes/books.ts billMoneyOutSql: a bill's amount_paid beyond its
-- payment rows counts on the day it was paid off), so no second backfill is
-- needed and nothing is counted twice.
-- Safe drop: the table (Cash Flow would fall back to nothing for bills).

CREATE TABLE books_bill_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id       uuid NOT NULL REFERENCES books_bills(id) ON DELETE CASCADE,
  landlord_id   uuid NULL REFERENCES landlords(id) ON DELETE CASCADE,
  business_id   uuid NULL REFERENCES businesses(id) ON DELETE CASCADE,
  paid_on       date NOT NULL,
  amount        numeric(12,2) NOT NULL,
  vendor_credit numeric(12,2) NOT NULL DEFAULT 0,
  source        varchar(20) NOT NULL DEFAULT 'payment',
  created_by    uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT books_bill_payments_one_owner CHECK (num_nonnulls(landlord_id, business_id) <= 1),
  CONSTRAINT books_bill_payments_amounts_check
    CHECK (amount >= 0 AND vendor_credit >= 0 AND amount + vendor_credit > 0),
  CONSTRAINT books_bill_payments_source_check CHECK (source IN ('payment', 'backfill'))
);

CREATE INDEX books_bill_payments_bill_idx ON books_bill_payments (bill_id);
CREATE INDEX books_bill_payments_landlord_day_idx
  ON books_bill_payments (landlord_id, paid_on) WHERE landlord_id IS NOT NULL;
CREATE INDEX books_bill_payments_business_day_idx
  ON books_bill_payments (business_id, paid_on) WHERE business_id IS NOT NULL;

INSERT INTO books_bill_payments (bill_id, landlord_id, business_id, paid_on, amount, source, created_at)
SELECT b.id, b.landlord_id, b.business_id,
       COALESCE(b.paid_at, b.updated_at, b.created_at)::date,
       b.amount_paid, 'backfill',
       COALESCE(b.paid_at, b.updated_at, b.created_at)
  FROM books_bills b
 WHERE b.amount_paid > 0;
