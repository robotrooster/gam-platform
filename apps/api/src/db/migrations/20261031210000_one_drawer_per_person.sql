-- 10/31 (Nic) — ONE PERSON, ONE DRAWER, FOR THE WHOLE SHIFT.
--
--   "We should have it where I can't ring sales on this register and the second
--    register. If I'm on the first register, that's it for the shift, sort of
--    thing. Unless you go through the countdown process and you close it out
--    back to default and then count in on a new register."
--
-- The table already allowed one open shift per REGISTER
-- (ux_pos_register_shifts_one_open), which stops two people sharing a drawer.
-- This is the other direction: one open shift per PERSON, so a cashier cannot
-- be signed into two drawers at once and ring into whichever is in front of
-- them. A person is physically at one till; their cash is accountable to one
-- count.
--
-- Switching registers is deliberately the long way round — count the first one
-- down, close it, then count in on the new one. That is the whole point: the
-- money in a drawer has to be answerable by the person who was on it.
--
-- A MANAGER COVERING A BREAK is unaffected and is exactly why this is per
-- person rather than per property: the employee holds Register 1, the manager
-- opens their own shift on Register 2, and each counts their own down. His own
-- case for it.
--
-- No backfill: at most a handful of shifts exist and none are open.

CREATE UNIQUE INDEX IF NOT EXISTS ux_pos_register_shifts_one_per_person
  ON pos_register_shifts (opened_by_user_id) WHERE status = 'open';

COMMENT ON INDEX ux_pos_register_shifts_one_per_person IS
  '10/31 (Nic): "If I''m on the first register, that''s it for the shift." One open drawer per person — switching means counting the first one down and closing it.';
