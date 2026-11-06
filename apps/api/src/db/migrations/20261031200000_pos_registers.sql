-- 10/31 (Nic) — A REGISTER IS A THING, AND IT CARRIES ITS OWN STARTING CASH.
--
-- GAM already closes a business day per property and works out the cash the
-- drawer SHOULD hold (pos_eod_settlements, running nightly since S95). What it
-- has never had is a register: the key is one count per property per day, every
-- one of the 20 live rows is auto-closed, opening_float has always been 0.00 and
-- cash_drawer_actual has never once been filled in, because no screen could.
--
-- A location can run several drawers — "one he knows runs four" — so the count
-- belongs to a register, not a property.
--
-- ── STARTING CASH, AND WHY NOTHING INHERITS ─────────────────────────────────
--
-- Nic, 10/31: "If somebody's using more than one register... you could set it
-- per register... It doesn't need to be the same across each register at the
-- property." His case is a second register kept for break coverage, opened for
-- twenty minutes by a manager, which plainly needs a different amount than the
-- main one.
--
-- And on a platform default: "I don't want to have any default for that at the
-- platform level. Like, I mean, it can suggest $100, but nothing is set in
-- stone. They would have to confirm it."
--
-- So the amount lives HERE and nowhere else. No company column and no property
-- column is ever read to fill it in — that is the thing he was angry about in
-- October, a higher level silently deciding a lower one. GAM suggests $100 in
-- the box; a human confirms it; `starting_cash_confirmed_at` records that they
-- did. **A register with nothing confirmed cannot open a shift** — the app asks
-- rather than guessing, because a guessed starting amount makes every count
-- after it meaningless.
--
-- The word "float" is deliberately absent. Asked what it meant, he had never
-- heard it; the screens say "starting cash — what stays in the drawer."
--
-- CENTS, not numeric. Counting a drawer by denomination is integer arithmetic
-- and a float would eventually argue with the cashier about a penny.
--
-- Retired, never deleted: a retired register keeps its shifts and its counts
-- ([[gam-data-retention-keep-everything]], the units retire/replace pattern).
--
-- No backfill: no property has registers yet, and the day settlement keeps
-- working exactly as it does for anyone who never makes one.

CREATE TABLE IF NOT EXISTS pos_registers (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  landlord_id                 uuid NOT NULL REFERENCES landlords(id) ON DELETE RESTRICT,
  property_id                 uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  -- What staff call it out loud: "Register 2", "Front Desk", "Store".
  name                        text NOT NULL,
  status                      text NOT NULL DEFAULT 'active',
  -- What stays in the drawer. NULL until a human confirms it.
  starting_cash_cents         integer,
  -- {denomination_cents: how many}. Optional: an operator who wants to tell
  -- staff "five 5s and 75 1s" fills it, and its total must equal the amount.
  starting_cash_breakdown     jsonb,
  starting_cash_confirmed_at  timestamptz,
  starting_cash_confirmed_by_user_id uuid REFERENCES users(id),
  -- Over this much off, closing asks what happened. Per register, same reasoning.
  variance_reason_over_cents  integer,
  created_at                  timestamptz NOT NULL DEFAULT NOW(),
  updated_at                  timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE pos_registers DROP CONSTRAINT IF EXISTS pos_registers_status_check;
ALTER TABLE pos_registers
  ADD CONSTRAINT pos_registers_status_check CHECK (status IN ('active', 'retired'));

ALTER TABLE pos_registers DROP CONSTRAINT IF EXISTS pos_registers_amounts_sane;
ALTER TABLE pos_registers
  ADD CONSTRAINT pos_registers_amounts_sane CHECK (
    (starting_cash_cents IS NULL OR starting_cash_cents >= 0)
    AND (variance_reason_over_cents IS NULL OR variance_reason_over_cents >= 0));

-- Confirmation is all-or-nothing: an amount with nobody's name on it is the
-- guessed default this whole table exists to avoid.
ALTER TABLE pos_registers DROP CONSTRAINT IF EXISTS pos_registers_confirmed_together;
ALTER TABLE pos_registers
  ADD CONSTRAINT pos_registers_confirmed_together CHECK (
    (starting_cash_cents IS NULL AND starting_cash_confirmed_at IS NULL)
    OR (starting_cash_cents IS NOT NULL AND starting_cash_confirmed_at IS NOT NULL));

-- Two active registers at one place cannot share a name — staff say these out
-- loud to each other. A retired one frees its name again.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pos_registers_active_name
  ON pos_registers (property_id, lower(btrim(name))) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS ix_pos_registers_property ON pos_registers (property_id, status);

COMMENT ON TABLE pos_registers IS
  '10/31: a till at a location. Carries its OWN starting cash — no company or property value is ever read to fill it, and a register with none confirmed cannot open a shift.';
COMMENT ON COLUMN pos_registers.starting_cash_cents IS
  '10/31: what stays in the drawer for the next shift, in cents. NULL = nobody has confirmed one yet, so no shift can open. GAM suggests $100 in the box; it is never written without a person.';
COMMENT ON COLUMN pos_registers.starting_cash_breakdown IS
  '10/31 (Nic): {denomination_cents: count}. "$200" paid with two $100 bills cannot break a hundred for a $4 bag of ice, which is why denominations exist. Optional; when present its total must equal starting_cash_cents.';
