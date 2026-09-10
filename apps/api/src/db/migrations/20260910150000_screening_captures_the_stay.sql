-- S639 (Nic): "I've marked him as approved, but what is the next course of
-- action? I need to generate him a lease. I don't know how much he's wanting to
-- have the spot for... maybe we should have a term length of stay on the initial
-- field before the Checker flow. I don't wanna do back and forth with — hey,
-- they told me something, and then I forgot because I was busy, and then they
-- finally get around to do the background check, and then I have to see what
-- they want. I wanted to just draft up a lease from the information on the
-- background check."
--
-- GAM has three acquisition doors and only two of them carry the stay:
--   · a BOOKING knows its dates, so a 30+ night stay drafts a lease already;
--   · an APPLICATION carries move_in_date, occupants and pets, and
--     applicationLeaseDraft turns it into a lease;
--   · a SCREENING sent directly to somebody — how Nic actually onboards — asks
--     for identity, employment and consent, and NOTHING about the tenancy being
--     applied for. So approval lands on "now what", and the terms live in a
--     conversation he had days ago.
--
-- These two columns are the missing half. Deliberately only two: the move-in and
-- the length are what a lease cannot be drafted without, and everything else
-- about the stay is either already on the unit or genuinely belongs in a
-- conversation.
ALTER TABLE background_checks
  ADD COLUMN IF NOT EXISTS desired_move_in       date,
  ADD COLUMN IF NOT EXISTS desired_term_months   integer,
  -- Month-to-month is a real answer and not a number of months, so it cannot be
  -- expressed by the integer above.
  ADD COLUMN IF NOT EXISTS desired_month_to_month boolean NOT NULL DEFAULT false;

ALTER TABLE background_checks
  ADD CONSTRAINT background_checks_term_sane
  CHECK (desired_term_months IS NULL OR (desired_term_months > 0 AND desired_term_months <= 120));

COMMENT ON COLUMN background_checks.desired_move_in IS
  'S639: when the applicant says they want to move in. Captured at screening so an approval can draft a lease without a phone call.';
COMMENT ON COLUMN background_checks.desired_term_months IS
  'S639: how many months they want. NULL with desired_month_to_month = true means month-to-month.';
