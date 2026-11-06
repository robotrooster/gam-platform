-- 10/31 (Nic) — THE SHIFT, AND COUNTING THE DRAWER DOWN TO ITS STARTING CASH.
--
--   "Two to three shifts a day, so a drawer is counted several times a day,
--    each with its own starting amount."
--
-- A drawer count is NOT a bank trip (10/30, directive): staff count the drawer
-- down to what it started with so the register zeroes out, and the money pulled
-- out sits until a bank run is worth making — "it's not worth the gas to drive
-- $100 to the bank when another $100 might come tomorrow." So ONE deposit is
-- often several days of drops. This table is the first stage only. The drop is
-- recorded here; bundling drops into a bank deposit is its own later thing and
-- is deliberately not modelled yet.
--
-- ── WHY THE STARTING CASH IS COPIED ONTO THE SHIFT ──────────────────────────
--
-- `opening_cash_cents` is a SNAPSHOT taken when the shift opens, not a lookup
-- to pos_registers. Change the register's configured amount next month and
-- every past shift's arithmetic would silently move with it — the same class of
-- mistake as a re-keyed meter read rewriting a settled month. What the drawer
-- started with that morning is a fact about that morning.
--
-- ── WHAT "SHORT" MEANS ──────────────────────────────────────────────────────
--
-- expected = opening cash + cash taken in on this shift - cash paid back out.
-- variance = counted - expected. Negative is short, positive is over.
-- drop     = counted - opening cash: what physically leaves the drawer.
--
-- Nic, 10/31, on a count that does not match: close it anyway and require a
-- typed reason over a threshold the operator sets. "The cashier can always
-- finish their shift" — nothing traps somebody at the end of a shift, and a
-- real miss gets an explanation attached while they still remember. The
-- threshold is per register (pos_registers.variance_reason_over_cents); the
-- rule is enforced in the route, not here, because an operator who lowers the
-- threshold later must not invalidate a shift that closed correctly under the
-- old one.
--
-- ONE OPEN SHIFT PER REGISTER, enforced by a partial unique index: two people
-- ringing into one drawer on two shifts makes both counts meaningless.
--
-- No backfill: no shifts exist, and the nightly day settlement is unchanged for
-- any property that never makes a register.

CREATE TABLE IF NOT EXISTS pos_register_shifts (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  register_id             uuid NOT NULL REFERENCES pos_registers(id) ON DELETE RESTRICT,
  landlord_id             uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
  property_id             uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  -- The local calendar day the shift OPENED on, so it rolls up with the day
  -- settlement even when a late shift runs past midnight.
  business_day            date NOT NULL,
  status                  text NOT NULL DEFAULT 'open',

  opened_by_user_id       uuid NOT NULL REFERENCES users(id),
  opened_at               timestamptz NOT NULL DEFAULT NOW(),
  -- Snapshot. See above.
  opening_cash_cents      integer NOT NULL,
  opening_cash_breakdown  jsonb,

  closed_by_user_id       uuid REFERENCES users(id),
  closed_at               timestamptz,
  counted_cash_cents      integer,
  counted_cash_breakdown  jsonb,
  expected_cash_cents     integer,
  variance_cents          integer,
  variance_reason         text,
  drop_cents              integer,
  notes                   text,

  created_at              timestamptz NOT NULL DEFAULT NOW(),
  updated_at              timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE pos_register_shifts DROP CONSTRAINT IF EXISTS pos_register_shifts_status_check;
ALTER TABLE pos_register_shifts
  ADD CONSTRAINT pos_register_shifts_status_check CHECK (status IN ('open', 'closed'));

ALTER TABLE pos_register_shifts DROP CONSTRAINT IF EXISTS pos_register_shifts_opening_sane;
ALTER TABLE pos_register_shifts
  ADD CONSTRAINT pos_register_shifts_opening_sane CHECK (opening_cash_cents >= 0);

-- A closed shift has been counted; an open one has not. Either every closing
-- field is there or none is.
ALTER TABLE pos_register_shifts DROP CONSTRAINT IF EXISTS pos_register_shifts_closed_together;
ALTER TABLE pos_register_shifts
  ADD CONSTRAINT pos_register_shifts_closed_together CHECK (
    (status = 'open'
      AND closed_at IS NULL AND closed_by_user_id IS NULL AND counted_cash_cents IS NULL)
    OR (status = 'closed'
      AND closed_at IS NOT NULL AND closed_by_user_id IS NOT NULL
      AND counted_cash_cents IS NOT NULL AND counted_cash_cents >= 0
      AND expected_cash_cents IS NOT NULL AND variance_cents IS NOT NULL AND drop_cents IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS ux_pos_register_shifts_one_open
  ON pos_register_shifts (register_id) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS ix_pos_register_shifts_day
  ON pos_register_shifts (property_id, business_day);
CREATE INDEX IF NOT EXISTS ix_pos_register_shifts_register
  ON pos_register_shifts (register_id, opened_at DESC);

COMMENT ON TABLE pos_register_shifts IS
  '10/31: one sitting at one register. Counted down to its starting cash at the end; the remainder is the drop, which waits for a bank run worth making. A drawer count and a bank trip are two events, not one.';
COMMENT ON COLUMN pos_register_shifts.opening_cash_cents IS
  '10/31: a SNAPSHOT of the register starting cash when this shift opened, never a live lookup — editing the register later must not move a past shift''s arithmetic.';
COMMENT ON COLUMN pos_register_shifts.drop_cents IS
  '10/31: counted - opening cash. What physically comes out of the drawer and waits for a bank deposit (a later, separate stage).';
COMMENT ON COLUMN pos_register_shifts.variance_cents IS
  '10/31: counted - expected. Negative is short. A shift ALWAYS closes (Nic: "the cashier can always finish their shift"); over the register''s threshold the route requires a typed reason.';
