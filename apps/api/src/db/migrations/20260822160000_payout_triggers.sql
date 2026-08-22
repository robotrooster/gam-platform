-- S616 (Nic) — pay the landlord sooner without paying Stripe more.
--
--   "That's a lot of margin we're giving up on an extra twenty five cent
--    initiation. If we're doing that ten times a month instead of two or three
--    strategic ones per connect account, that's a lot of money. It's these
--    little microscopic decisions that add up to lots of money at scale... we're
--    processing sixty million dollars a month and spending ten thousand dollars
--    a month on extra processing charges that could be eliminated."
--
-- The weekly Tuesday batch could leave rent settled at Stripe on a Thursday and
-- sitting until the following Tuesday — up to five days of the landlord's money
-- held for nothing but cadence. But a daily sweep multiplies the $0.25-per-
-- initiation cost by every landlord, every day, and at scale that is real money
-- spent on nothing.
--
-- Nic's answer, and it is better than a dollar threshold because it is BOUNDED:
-- fire on how much of the rent roll has actually come in.
--
--   "Most people pay on time, and you don't wanna be stuck on the outliers. So
--    let's fire a disbursement when it's fifty percent of occupied units paid...
--    and then we do another one at ninety percent... you don't want the landlord
--    being held up by a bunch of rent money for one or two late people."
--
-- Three firings per Connect account per month, maximum, forever:
--   1. 50% of occupied units paid  → scheduled 4 days out
--   2. 90% of occupied units paid  → scheduled 4 days out
--   3. a guaranteed late-month sweep, which also covers the month where the
--      thresholds never trip at all (a bad month, or a two-unit landlord).
--
-- A DOLLAR THRESHOLD WAS THE WRONG SHAPE and Nic said so: $500 fires on every
-- single Oak Park tenant (rent is $440 plus utilities, so every payment clears
-- it), while $3,000 never trips for a landlord holding three single-family
-- houses. A percentage is relative to the landlord's own roll, so one rule fits
-- both — and unlike a threshold it has a ceiling.
--
-- WHY THE COUNT IS THE POINT: three firings is $0.75 a month against a $10
-- per-property floor. The expense is known in advance and can never run away,
-- which a balance trigger cannot promise.
--
-- SCHEDULED FOUR DAYS OUT, on PAID rather than SETTLED (Nic). Stripe holds an
-- ACH debit about four business days, so scheduling on the day the tenants pay
-- front-runs that wait instead of discovering it. Stripe only ever releases
-- cleared funds, so the firing takes whatever has actually settled by then — an
-- empty one costs nothing and is skipped.

CREATE TABLE IF NOT EXISTS payout_triggers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The Connect account this pays out. Per Nic: scoped to the ACCOUNT, not the
  -- property — a landlord with five properties shares one balance, so
  -- per-property thresholds would fire five times over the same money.
  entity_kind       text NOT NULL CHECK (entity_kind IN ('user','pm_company','business')),
  entity_id         uuid NOT NULL,

  -- The rent cycle this belongs to. The month is what bounds the count.
  cycle_month       date NOT NULL,

  trigger_kind      text NOT NULL
                    CHECK (trigger_kind IN ('threshold_50','threshold_90','monthly_sweep')),

  -- What the roll looked like when it tripped, kept because "why did this fire"
  -- is the first question anyone asks of an automated money movement.
  units_total       integer,
  units_paid        integer,

  scheduled_for     date NOT NULL,
  fired_at          timestamptz,
  -- Set when the firing found nothing to send. Not a failure: the tenants paid
  -- but Stripe has not released it yet, and the next trigger picks it up.
  skipped_reason    text,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- THE CAP, enforced by the database rather than by the code that reads it.
-- One row per (account, month, trigger) means three firings a month is not a
-- policy someone can accidentally loosen — it is a constraint.
CREATE UNIQUE INDEX IF NOT EXISTS ux_payout_triggers_one_per_cycle
  ON payout_triggers (entity_kind, entity_id, cycle_month, trigger_kind);
CREATE INDEX IF NOT EXISTS idx_payout_triggers_due
  ON payout_triggers (scheduled_for) WHERE fired_at IS NULL;

COMMENT ON TABLE payout_triggers IS
  'S616: what earned a landlord payout and when it is scheduled. At most three '
  'rows per Connect account per rent cycle — 50% of units paid, 90%, and a '
  'guaranteed late-month sweep — so the per-initiation cost is capped at $0.75 '
  'a month and known in advance.';
