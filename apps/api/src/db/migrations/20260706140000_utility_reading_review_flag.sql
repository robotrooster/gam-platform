-- Reading review flags — "no giveaways for bad readings" (Nic, S532).
--
-- During the blind reading walk, a value below the meter's previous
-- reading is ACCEPTED with no feedback to the reader (an error would
-- give away the prior value / that something is off). Instead the row
-- is flagged for a landlord double-check. The billing engine already
-- refuses to bill negative usage, so a flagged reading can't produce a
-- bad bill; resolving the flag (correct the value, or confirm a genuine
-- rollover/meter swap) re-runs billing for that cycle if the run has
-- already completed.
--
-- No backfill needed: all existing readings were entered under the old
-- reject-on-entry rule, so none can be retroactively bad.

ALTER TABLE utility_meter_readings
    ADD COLUMN needs_review boolean NOT NULL DEFAULT false,
    ADD COLUMN review_note text;

CREATE INDEX idx_utility_meter_readings_needs_review
    ON utility_meter_readings (meter_id)
    WHERE needs_review;
