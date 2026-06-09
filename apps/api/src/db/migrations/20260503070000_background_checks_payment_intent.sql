-- S83 / Item 16 batch 3: applicant background-check payment becomes a real
-- Stripe PaymentIntent (was a mock pi_intake_<random> string in S58-S82).
-- Add the column that anchors the link between the applicant's submitted
-- background check and the Stripe charge that paid for it.
--
-- UNIQUE: a single PaymentIntent can only fund ONE background check submit.
-- Re-using the same intent_id (deliberately or by replay) hits this
-- constraint on the second insert. Matches webhook idempotency posture
-- elsewhere in the codebase (payments.stripe_payment_intent_id is also
-- one-PI-to-one-row).
--
-- Nullable: legacy rows from the mock era are NULL. The /submit verification
-- code only writes the column for new rows. No backfill needed.

ALTER TABLE background_checks
  ADD COLUMN applicant_payment_intent_id text;

CREATE UNIQUE INDEX background_checks_applicant_pi_uniq
  ON background_checks(applicant_payment_intent_id)
  WHERE applicant_payment_intent_id IS NOT NULL;
