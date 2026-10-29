-- 10/13 — "WORKS, NOBODY USING IT" ON A FLAT-RATE METER: STOP THE FLAT CHARGE TOO?
--
-- Nic, 10/13: "Flat-rate meter marked 'Works, nobody using it': LANDLORD'S
-- CHOICE, asked at the moment of marking ('Stop the flat charge too?')."
--
-- "Works, tenant uses no power" (10/12, M1; usable on any meter, Q-d) records
-- utility_meters.zero_use_confirmed_at. On a flat-rate meter it changed nothing
-- about billing: the flat charge kept going out every month to every unit on
-- the meter. Now the landlord answers, when they mark it, whether the flat
-- charge stops too:
--   yes — the flat charge stops while the meter is marked unused, and starts
--         again once it is not (taken back, marked broken, or ended when the
--         household it was confirmed for leaves);
--   no  — it keeps billing, as before.
--
-- zero_use_stops_flat_charge is that answer. It counts only while
-- zero_use_confirmed_at is set (services/utilityBilling, the flat branch of
-- generateBillsForMeter), and is written with it and cleared with it
-- (services/meterRepair, routes/utility, services/utilityBilling). Always FALSE
-- on a meter that is not a flat rate (routes/utility refuses the answer there).
--
-- Expand-only: one column, default FALSE, so every meter bills exactly as it
-- did. No backfill needed — no meter has been asked yet. Idempotent.

ALTER TABLE utility_meters ADD COLUMN IF NOT EXISTS zero_use_stops_flat_charge boolean NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN utility_meters.zero_use_stops_flat_charge IS
  '10/13 (Nic): the landlord''s answer to "Stop the flat charge too?" when marking a flat-rate meter "Works, nobody using it". TRUE: the flat charge is not billed while zero_use_confirmed_at is set, and bills again once it is cleared. Counts only while zero_use_confirmed_at is set; written and cleared with it.';
