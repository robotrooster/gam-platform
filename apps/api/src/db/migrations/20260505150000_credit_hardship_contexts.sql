-- Credit Ledger v1: hardship contexts.
--
-- Tenant-attested optional context that doesn't erase events but adds
-- explanation alongside. A hardship_context row links to its triggering
-- ledger event ('hardship_context_added'). Range is start_date through
-- optional end_date; ongoing hardships have NULL end_date.
--
-- Score formulas don't read this table — hardship is purely contextual,
-- shown in stats panel and dispute UX. The locked design rule "facts
-- not interpretations" means we don't reweight events based on claimed
-- hardship; the tenant's record is what it is, but the context exists
-- for human review.
--
-- No backfill needed.

CREATE TABLE credit_hardship_contexts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_id  UUID NOT NULL REFERENCES credit_subjects(id),
  category    TEXT NOT NULL CHECK (category IN (
    'medical',
    'job_loss',
    'family_death',
    'natural_disaster',
    'military_deployment',
    'other'
  )),
  start_date  DATE NOT NULL,
  end_date    DATE,
  note        TEXT,
  event_id    UUID NOT NULL REFERENCES credit_events(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_credit_hardship_subject ON credit_hardship_contexts (subject_id, start_date);
