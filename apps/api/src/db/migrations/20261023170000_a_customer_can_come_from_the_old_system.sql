-- 10/21 (Nic) — CUSTOMERS CARRIED OVER FROM THE SYSTEM THE PARK USED BEFORE.
--
--   "I don't need the reservation history... I just need the customer data."
--   "there's a lot of throwaway customers that are not obviously real."
--
-- Mountain View ran on Campground Master before GAM, and Oak Park's old Square
-- account holds the same kind of list. Those people are real customers of a
-- real business — they just arrived in a file rather than at the counter.
--
-- `created_from` could only say 'manual' (somebody typed them) or 'card_reader'
-- (a card was tapped). An imported row is neither, and calling it 'manual'
-- would quietly claim a person typed in seven hundred customers. It also
-- matters later: when two records turn out to be the same person, which one was
-- typed by somebody who knew them and which one came out of a file is the first
-- thing you want to know.
ALTER TABLE pos_customers DROP CONSTRAINT IF EXISTS pos_customers_created_from_check;
ALTER TABLE pos_customers ADD CONSTRAINT pos_customers_created_from_check
  CHECK (created_from IN ('manual', 'card_reader', 'import'));

COMMENT ON COLUMN pos_customers.created_from IS
  'How the record came to exist: typed at the counter, taken off a card reader, or carried over from the system the park used before GAM (10/21).';
