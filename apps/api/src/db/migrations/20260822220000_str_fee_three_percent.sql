-- S616 (Nic): the short-term-stay revenue fee drops from 5% to 3%.
--
-- Applies to the unit types that bill a PERCENTAGE OF BOOKING REVENUE rather
-- than nights — hotel rooms, parking, land lots, cabins. RV spots, campsites
-- and boat slips are unaffected: they bill CEIL(nights / 30) × $2, which Nic
-- confirmed separately ("the first thirty is two dollars, the next thirty or
-- portion thereof is another two dollars").
--
-- Versioned rather than updated in place, which is what the effective_from /
-- effective_until pair on this table is for. The old row is CLOSED, not
-- rewritten: an accrual already posted at 5% was correct when it was posted,
-- and rewriting the rate it was computed from would make history disagree with
-- the ledger.
UPDATE platform_fee_config
   SET effective_until = CURRENT_DATE
 WHERE effective_until IS NULL;

INSERT INTO platform_fee_config
  (rate_per_unit, min_per_property, str_fee_pct, effective_from, notes)
SELECT rate_per_unit, min_per_property, 0.0300, CURRENT_DATE,
       'S616 (Nic): STR revenue fee 5% -> 3%. Per-unit rate and property '
       'minimum unchanged.'
  FROM platform_fee_config
 WHERE effective_until = CURRENT_DATE
 ORDER BY effective_from DESC
 LIMIT 1;
