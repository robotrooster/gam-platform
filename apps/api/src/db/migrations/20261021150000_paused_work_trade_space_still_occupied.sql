-- 10/19 (Nic) — WHEN A WORK TRADE IS PAUSED, IS THE CAMPER STILL ON THE SPOT?
--
-- "A paused work trade that counts hours should continue to count hours. If, I
-- mean, basically the landlord needs to have a way to set whether they occupy
-- the spot or not. Because if somebody wants to work more hours in the winter
-- but leave their camper occupying the space in the summer, that's one
-- situation. If people take their camper home for the summer with them and it's
-- not occupying the spot, then there would be no reason for it to continue to
-- track hours. So that's another thing you're asking me about, which needs to
-- be an individual landlord decision. We're going for flexibility and
-- transparency and honesty on both sides. We're letting landlords operate how
-- they want to. We recommend they follow the laws applicable to their location,
-- but we are not enforcing anything."
--
-- This is his answer to the question the 10/18 close left open in
-- jobs/workTradeSettlement (CLOSE_STATUSES): a paused agreement that counts
-- hours was leaving the unworked part of its last month owed on that month's
-- bill while the person was away for the season. Whether that is right turns
-- out not to be a rule GAM gets to pick — it depends on whether the space is
-- still being used, and only the landlord knows that, per agreement.
--
-- THREE STATES, and the third is not a bug:
--   TRUE   the space is still being used while this is paused. Hours keep
--          counting and the month behaves exactly as it does today.
--   FALSE  the space is empty. No hours are asked for while this is paused, so
--          the months the trade covers are covered outright and settle — a
--          work trade's coverage is never turned into a debt (Nic's standing
--          rule), and there is nothing to track when nobody is there.
--   NULL   nobody has been asked yet. Two paths pause an agreement without a
--          landlord in front of a screen — lease hibernation (routes/leases)
--          and a lease expiring with no successor (jobs/scheduler) — so an
--          unanswered pause is the normal state of a freshly paused agreement.
--          It reads as "still being used": that is what every paused agreement
--          does today, so nothing anybody is billed moves until a landlord
--          answers on purpose.
--
-- NO BACKFILL NEEDED, and deliberately so. Leaving the existing rows NULL is
-- what makes this release change no money: the two live paused agreements (RV
-- 50 and RV 51 at Mountain View) have tracks_hours = false, so they never
-- counted an hour either way, and every other paused agreement keeps today's
-- behavior until someone answers the question.
--
-- SAFE DROP: nothing reads the column until the code that ships after this
-- migration does, and the readers (services/workTradeStanding HOURS_COUNTED_SQL)
-- reach it through to_jsonb so they keep working on a database that has not had
-- this migration yet.
--
-- The change journal picks the answer up for free: work_trade_agreements
-- already carries audit_work_trade_agreements, so every change of mind about a
-- space is recorded with the row it changed.

ALTER TABLE work_trade_agreements
  ADD COLUMN IF NOT EXISTS paused_space_occupied boolean;

COMMENT ON COLUMN work_trade_agreements.paused_space_occupied IS
  'While this agreement is paused, is the space still being used? TRUE keeps counting hours (the month behaves as normal), FALSE asks for no hours, NULL means the landlord has not been asked and reads as TRUE. Read only while the trade is not running (paused, or ended straight out of a pause) and forgotten the moment it resumes. Nic 10/19.';

-- ── THE ANSWER BELONGS TO THIS PAUSE, NOT TO THE AGREEMENT FOREVER ──────────
--
-- A snowbird's trade pauses and resumes every year. If last winter's "they took
-- the camper home" answer were still sitting on the row when the trade RESUMED,
-- hours would stop being counted on a running agreement with somebody parked on
-- the spot — the landlord would be giving away a month of labor and reading a
-- screen that said so in small print. So the answer is forgotten the moment the
-- trade starts running again.
--
-- A TRIGGER rather than a line in every caller, for the reason the units rules
-- are triggers: FIVE places put an agreement back to active (routes/leases on
-- lease resume, routes/workTrade, scripts/mattoon load24, lib/unwindIssuedLease,
-- services/stayWorkTrade) and the next one written would not know to do it.
-- Several of those are not work-trade code at all and have no reason to.
--
-- IT HOLDS WHENEVER THE ROW IS ACTIVE, not only on the step that got it there.
-- "On the way into active" was the first draft of this rule, and it left the
-- invariant with a hole: an answer written while the agreement was ALREADY
-- active is no transition, so nothing cleared it, and nothing looked wrong
-- either — the answer is only read on a dormant trade. It sat on a running
-- agreement until the next lease hibernation paused it, and then stopped
-- counting hours on a pause nobody had ever been asked about: every open month
-- covered outright, the carried catch-up cleared, and the work-trade window
-- telling the tenant their space was empty with the camper possibly still on
-- the spot. Stating it as "an ACTIVE agreement never carries a pause answer"
-- rather than as a transition rule closes that, and it stays true however the
-- row is written — by a route, a script, or a hand-run UPDATE.
--
-- It is still safe either side of the question:
--   - pausing (active → paused) in the same statement that records the answer
--     keeps the answer; the row is not active when it lands.
--   - ENDING out of a pause (paused → ended) keeps it, deliberately. Nic's rule
--     for ending by hand is that "any percentage of hours unpaid or uncompleted
--     is billed immediately" — and on a trade that asked for no hours, none are
--     uncompleted. Forgetting it here would bill a tenant for a season they were
--     told plainly nobody was counting (services/workTradeStanding), which is
--     the one thing this whole change exists to stop.
--   - re-running the same UPDATE on an active row writes NULL over NULL.
CREATE OR REPLACE FUNCTION work_trade_pause_answer_follows_the_pause()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'active' THEN
    NEW.paused_space_occupied := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- INSERT as well as UPDATE: an agreement is born active (services/workTrade,
-- services/stayWorkTrade), so a row arriving with an answer already on it would
-- be a pause answer on a trade that has never paused.
DROP TRIGGER IF EXISTS work_trade_pause_answer_resets ON work_trade_agreements;
CREATE TRIGGER work_trade_pause_answer_resets
  BEFORE INSERT OR UPDATE ON work_trade_agreements
  FOR EACH ROW EXECUTE FUNCTION work_trade_pause_answer_follows_the_pause();
