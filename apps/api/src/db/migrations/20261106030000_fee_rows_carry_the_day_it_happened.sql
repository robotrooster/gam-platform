-- 11/5 (Nic) — A BOUNCE FEE SAYS WHICH BOUNCE IT IS FOR.
--
--   "For now, just separate the line items by putting the bounce date on
--    there."
--
-- WHAT WAS WRONG. Heather Miller's November bill carries TWO returned-payment
-- fees, and both lines read "Returned-payment fee  $4.00" with nothing
-- whatsoever to tell them apart. That is not a cosmetic problem: it fooled ME
-- into telling Nic the second one was a duplicate, and he had to go into Stripe
-- himself to prove there were two real refusals. A resident reading that bill
-- would reach the same wrong conclusion with less to go on.
--
-- WHY A COLUMN AND NOT A DATE ALREADY ON THE ROW. The day a fee was WRITTEN is
-- not the day the bank said no, and Heather is the proof: Stripe's own record
-- has her pulls refused 11/1 (pi_3UXCMz) and 11/3 (pi_3UXtfx), while the two
-- fee rows were written 11/4 (by hand, before the automatic path existed) and
-- 11/5. due_date and created_at are both wrong for a label, and due_date
-- carries meaning elsewhere — moving it to suit a line of text would be
-- changing when GAM says money is owed in order to fix a word.
--
-- So the day is recorded as its own fact. It also stops being locked inside
-- prose: until now the only place a bounce date existed was the sentence in
-- `notes`, which is a dedupe key and not data anybody can read back.
--
-- WHICH FEES. Both of GAM's own pass-through fees, because they have the
-- identical defect: RETURNFEE ($4, a bank refusal) and DECLINEFEE ($1, a card
-- refused at the counter or online — two declines on one card read as one line
-- today). Nothing else uses it.
--
-- SAFE: nullable, no default, so no table rewrite and no row changes. A fee
-- written before today simply has no date and its line reads as it does now.
-- BACKFILL: Heather's two rows only, and they are corrected by their own dated
-- script (scripts/nov5_heather_bounce_dates.ts) against what Stripe says —
-- never guessed here, because one of the two notes has the wrong day in it and
-- a migration cannot check Stripe.

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS returned_on date;

COMMENT ON COLUMN payments.returned_on IS
  'For GAM''s own pass-through fee rows (RETURNFEE, DECLINEFEE): the day the '
  'bank refused the debit or the card was declined — taken from the Stripe '
  'event, not the day the fee was written. It is what tells two fees of the '
  'same kind apart on one bill (services/invoiceNotice chargeLabel).';
