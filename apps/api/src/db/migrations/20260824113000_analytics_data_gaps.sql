-- What landlords asked for that the platform cannot answer.
--
-- S618 (Nic): "the agent should be able to use existing data to put that
-- concept together, or at least be able to tell the landlord — hey, we don't
-- have all the data we need to track that type of information. And if that
-- response ever comes up, it should be set up where we start tracking that data
-- platform wide, within reason."
--
-- The second half is the part that needs a table. "We don't track that" is an
-- honest answer once; said repeatedly to different landlords about the same
-- thing, it is a product backlog nobody is writing down. So every time the
-- analytics tools are asked for a measure that does not exist, the ASK is
-- recorded here — not the answer, because there wasn't one.
--
-- Read it to decide what to start tracking: a measure requested forty times is
-- a feature, requested once is curiosity.
--
-- Deliberately records the requested MEASURE NAME and the question, never the
-- reply, and no tenant or personal data — this is a product signal, not a
-- transcript.
--
-- No backfill needed.

BEGIN;

CREATE TABLE IF NOT EXISTS analytics_data_gaps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who wanted it, so "how many different landlords asked" is answerable —
  -- one landlord asking nine times is not the same signal as nine landlords.
  landlord_id  uuid REFERENCES landlords(id) ON DELETE SET NULL,
  audience     text NOT NULL DEFAULT 'landlord'
                 CHECK (audience = ANY (ARRAY['landlord','tenant','guest','pm_company'])),

  -- Which tool was asked, and for what. `requested` is the measure/topic the
  -- agent reached for; `question` is the wording that prompted it, when known.
  tool         text NOT NULL,
  requested    text NOT NULL,
  question     text,

  created_at   timestamptz NOT NULL DEFAULT NOW()
);

-- The read that matters: what is asked for most, and by how many distinct
-- landlords.
CREATE INDEX IF NOT EXISTS idx_analytics_gaps_requested ON analytics_data_gaps(requested, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_gaps_landlord  ON analytics_data_gaps(landlord_id);

COMMIT;
