-- S654 (Nic): "if the base space rent for the property is $450 everywhere, John
-- Sheptock's $200 trailer payment would make it $650." The installment on a
-- park-financed home sale now rides the monthly rent invoice (one bill, one
-- email, one line on the who-owes page) instead of being billed as a standalone
-- charge at 4:20 that nothing else could see. This is where the invoice carries
-- what that part of the bill came to; the rows are type='home_payment' as before.
ALTER TABLE invoices ADD COLUMN subtotal_home_payments numeric(12,2) NOT NULL DEFAULT 0;
COMMENT ON COLUMN invoices.subtotal_home_payments IS 'S654: home-sale installments riding this invoice (type=home_payment rows); gross, like the other subtotals.';
