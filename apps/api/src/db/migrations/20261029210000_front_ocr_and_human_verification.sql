-- 10/29 (Nic): read the front with OCR, and have a person check the ones that
-- cannot be trusted yet.
--
--   "Maybe we can have it where gam to-do list for gam admin people is
--    verifying the front photo and typing it in by hand, or letting the parser
--    try to read the license and matching it up, and then we can flag a
--    percentage of accuracy of, hey, this one read, we're getting 99% accuracy
--    in this state, and this state is only 30% or something, and so these ones
--    need to be always verified by a real person."
--
-- THE BARCODE IS THE ANSWER KEY. Where a guest sends both sides, the back
-- decodes exactly — it is machine-readable by design — so it says what the
-- front SHOULD have said. Every front read can therefore grade itself against
-- it, for free, on real cards from real states. That is what makes a per-state
-- accuracy figure a measurement rather than a guess, and it costs nothing to
-- collect because both pictures are being taken anyway.
--
-- Over time that answers the question his rule needs: Arizona reads at 99%, so
-- trust it; a state reading at 30% goes to a person every time. A state nobody
-- has seen yet goes to a person too — silence is not a pass.
--
-- Two things stored:
--
--   id_front_reads   one row per front read, with what the OCR thought and
--                    whether the barcode agreed. The evidence behind every
--                    accuracy figure, kept so a number can always be explained
--                    and a threshold can be re-cut later without losing
--                    history.
--   needs_review     on the identification itself: this one is waiting for a
--                    person, and why, so the to-do can say so in words.
--
-- No backfill: one identification exists, from Checkr, where no front was read.

CREATE TABLE IF NOT EXISTS id_front_reads (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identification_id UUID NOT NULL REFERENCES tenant_identifications(id) ON DELETE CASCADE,
  -- Which state's card this was, because that is what the accuracy is OF.
  -- NULL when even that could not be determined, which is itself a bad read.
  issuing_state     TEXT,
  -- What the OCR made of it.
  read_id_number    TEXT,
  read_dob          DATE,
  ocr_confidence    NUMERIC(5,2),
  -- What the barcode said, when there was one. NULL means there was nothing
  -- to grade against — the read is unverified rather than wrong.
  truth_id_number   TEXT,
  truth_dob         DATE,
  -- Scored only where a truth exists. NULL = not gradeable.
  id_number_agreed  BOOLEAN,
  dob_agreed        BOOLEAN,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_id_front_reads_state
  ON id_front_reads (issuing_state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_id_front_reads_identification
  ON id_front_reads (identification_id);

ALTER TABLE tenant_identifications
  ADD COLUMN IF NOT EXISTS needs_review        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS review_reason       TEXT,
  ADD COLUMN IF NOT EXISTS reviewed_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reviewed_by         UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tenant_identifications_review
  ON tenant_identifications (needs_review) WHERE needs_review;

COMMENT ON TABLE id_front_reads IS
  '10/29: every OCR read of a licence FRONT, graded against the barcode on the back where there was one. The evidence behind the per-state accuracy figure that decides which states a person must check by hand.';
COMMENT ON COLUMN tenant_identifications.needs_review IS
  '10/29: a GAM admin has to look at this one — the OCR and the barcode disagreed, or there was no barcode and this state does not read reliably enough to trust. review_reason says which, in words the to-do can show.';
