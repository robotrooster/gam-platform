-- The first Flex price schedule governs from the start, not from the day it
-- was typed in.  (10/26 — a bug the test suite caught before it could bill.)
--
-- WHAT WENT WRONG.  Every row in flexpay_fee_schedule and
-- flexdeposit_fee_schedule carried effective_from = 2026-10-26, the day the
-- grids were drafted. Quotes resolve "the newest row at or before the asked-for
-- date", so ANY date before 10/26 had no bracket at all -- and a missing
-- bracket is deliberately an error rather than a zero. The FlexPay cover runs
-- on a bill's last grace day, which for an October bill is 10/06, so the cover
-- refused every bill it was asked to pay:
--
--   "FlexPay is not offered on a bill of $1,060.00"
--
-- on a bill that sits squarely in the $1,000-1,499 bracket. The refusal was the
-- services behaving correctly on a schedule that did not cover the date.
--
-- WHY BACKDATING IS THE RIGHT FIX AND NOT A REWRITE OF HISTORY.  The
-- append-only rule exists so a price already QUOTED keeps answering for the
-- dates it covered. There is no such price here: this is the FIRST schedule
-- either product has ever had, it has no predecessor to preserve, and no
-- enrollment has ever been priced from it. A first schedule has no start date
-- in the sense the rule cares about -- it simply governs. So its effective_from
-- moves back to a date earlier than any bill the platform could hold.
--
-- The NEXT re-price appends with a real forward date, and from that moment on
-- these rows stop being touched.
--
-- No backfill needed. Re-runnable: the UPDATEs are no-ops once applied.

UPDATE flexpay_fee_schedule
   SET effective_from = DATE '2020-01-01'
 WHERE effective_from = DATE '2026-10-26';

UPDATE flexdeposit_fee_schedule
   SET effective_from = DATE '2020-01-01'
 WHERE effective_from = DATE '2026-10-26';
