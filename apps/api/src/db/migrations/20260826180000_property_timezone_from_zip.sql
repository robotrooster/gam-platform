-- S624 — a property's clock should be its own, not Arizona's.
--
-- `properties.timezone` defaulted to 'America/Phoenix' for every row, because
-- the first properties on the platform were in Arizona. The first out-of-state
-- signup — an RV property in Hendersonville, North Carolina — landed on Arizona
-- time, three hours off.
--
-- That is not cosmetic. The late-fee engine runs on `NOW() AT TIME ZONE
-- p.timezone` (jobs/lateFees.ts) and the cron manager registers one run per
-- distinct property timezone, so a wrong zone means fees fire hours late and a
-- payment made after the local grace deadline can still register as on time.
--
-- WHY ZIP AND NOT STATE (Nic): fifteen states straddle a boundary — Texas,
-- Florida, Tennessee, Kentucky, Indiana, Idaho, Oregon, Nevada, Kansas,
-- Nebraska, the Dakotas, Michigan, Alaska, and Arizona's own Navajo Nation.
-- State alone is wrong for every one of them.
--
-- `timezone_source` records HOW the zone was arrived at, because a guess nobody
-- can see is a bug with a long tail:
--   derived  — state (or a documented ZIP range) settles it. Trustworthy.
--   inferred — the state splits and the ZIP did not land in a known range. Best
--              guess; the landlord is asked to confirm.
--   manual   — a human set it. Never overwritten by any later derivation.
--
-- Backfill deliberately does NOT touch rows a human has set, and marks
-- everything it could not settle as 'inferred' rather than pretending.

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS timezone_source text NOT NULL DEFAULT 'inferred';

ALTER TABLE properties DROP CONSTRAINT IF EXISTS properties_timezone_source_check;
ALTER TABLE properties ADD CONSTRAINT properties_timezone_source_check
  CHECK (timezone_source = ANY (ARRAY['derived','inferred','manual']));

COMMENT ON COLUMN properties.timezone_source IS
  'S624: how properties.timezone was arrived at — derived (state/ZIP settles it), inferred (split state, needs confirming), manual (a human set it).';

-- Backfill the states that live in exactly one zone. These are certain, so they
-- are marked 'derived' and need no human attention.
UPDATE properties SET timezone = t.tz, timezone_source = 'derived'
  FROM (VALUES
    ('CT','America/New_York'),('DE','America/New_York'),('DC','America/New_York'),
    ('GA','America/New_York'),('ME','America/New_York'),('MD','America/New_York'),
    ('MA','America/New_York'),('NH','America/New_York'),('NJ','America/New_York'),
    ('NY','America/New_York'),('NC','America/New_York'),('OH','America/New_York'),
    ('PA','America/New_York'),('RI','America/New_York'),('SC','America/New_York'),
    ('VT','America/New_York'),('VA','America/New_York'),('WV','America/New_York'),
    ('AL','America/Chicago'),('AR','America/Chicago'),('IL','America/Chicago'),
    ('IA','America/Chicago'),('LA','America/Chicago'),('MN','America/Chicago'),
    ('MS','America/Chicago'),('MO','America/Chicago'),('OK','America/Chicago'),
    ('WI','America/Chicago'),
    ('CO','America/Denver'),('MT','America/Denver'),('NM','America/Denver'),
    ('UT','America/Denver'),('WY','America/Denver'),
    ('CA','America/Los_Angeles'),('WA','America/Los_Angeles'),
    ('HI','Pacific/Honolulu')
  ) AS t(state, tz)
 WHERE UPPER(properties.state) = t.state
   AND properties.timezone_source <> 'manual';

-- Arizona is a split state (the Navajo Nation observes DST), but every existing
-- AZ property is an Oak Park one on Phoenix time and already correct. Mark them
-- derived so they are not dumped into the landlord's confirm queue for nothing.
UPDATE properties SET timezone_source = 'derived'
 WHERE UPPER(state) = 'AZ' AND timezone = 'America/Phoenix'
   AND timezone_source <> 'manual';
