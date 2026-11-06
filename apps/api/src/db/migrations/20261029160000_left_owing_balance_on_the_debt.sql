-- 10/29 (Nic): the settled balance belongs to the DEBT, not to one landlord's
-- arrangement — because the resident this product was built for moves.
--
--   "The entire point of this was because of semi-short-term RV stays where
--    people bounce around from place to place every month. If they leave
--    without paying their last electric bill and do the same thing next month
--    at another place and the same thing a third month at a third place...
--    the whole point of this collection system was for RVs specifically
--    because they're a lot more mobile."
--
-- left_owing_collections carries total_amount and collected_amount PER
-- (debt, collecting landlord), and the row is unique on that pair. One
-- landlord, one debt, one schedule — which is right for a resident who signs a
-- lease and stays. For a resident who spends a month in three different parks
-- it is wrong in the worst direction: each park opens its own arrangement for
-- the WHOLE settled amount, so an $800 debt can be collected three times over,
-- and whichever arrangement fills first marks the debt settled while the
-- others keep billing.
--
-- Nothing has ever been collected (left_owing_collections is empty), so there
-- is no history to unpick — but the defect is live and the feature cannot be
-- extended to stays on top of it.
--
-- So the two figures that must be true ACROSS every landlord move onto the
-- debt itself. An arrangement keeps its own collected_amount — that is how
-- each landlord's 15% is attributed and how a departure knows what THEY
-- fronted — but what is still owed, and when the debt is finished, is read
-- from here and nowhere else.
--
--   settled_amount    what the resident actually owes: 80% of `amount`
--                     (LEFT_OWING_SETTLEMENT_PCT). NULL until the first
--                     landlord takes them on, because until then there is no
--                     settlement — only a debt and a flag.
--   collected_amount  what every landlord together has collected toward it.
--
-- No backfill: one debt exists and no arrangement has ever opened against it,
-- so NULL/0 is the correct state for it.

ALTER TABLE tenant_left_owing
  ADD COLUMN IF NOT EXISTS settled_amount   NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS collected_amount NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE tenant_left_owing
  DROP CONSTRAINT IF EXISTS tenant_left_owing_collected_sane;
ALTER TABLE tenant_left_owing
  ADD CONSTRAINT tenant_left_owing_collected_sane
  CHECK (collected_amount >= 0
         AND (settled_amount IS NULL OR collected_amount <= settled_amount));

COMMENT ON COLUMN tenant_left_owing.settled_amount IS
  '10/29: what the resident actually owes once a landlord takes them on — 80% of amount (LEFT_OWING_SETTLEMENT_PCT). NULL before any arrangement exists. The figure every collecting landlord bills against, so three parks cannot each collect the whole balance.';
COMMENT ON COLUMN tenant_left_owing.collected_amount IS
  '10/29: collected toward settled_amount by EVERY landlord together. An individual arrangement''s own collected_amount is still its own, for attributing its 15% and for what it fronted at departure; this is the one that decides what is left and when the debt is done.';
