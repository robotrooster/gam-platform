-- Double-check verification phase (Nic, S533 redesign).
--
-- Suspicious readings must NOT interrupt the reading walk and must NOT
-- wait on a landlord modal. Instead: the reader completes the full walk,
-- gets back to the office, and the system generates a VERIFICATION LIST —
-- every suspicious meter plus randomly chosen clean ones so the list
-- always has at least 5-6 entries and the reader can't tell which ones
-- the system doubts (same blind-integrity principle as the walk itself).
-- The reader re-reads those meters blind; reconciliation is automatic:
--   - second read within 1-2 units of the first → the FIRST read stands
--     for billing (the meter simply moved between reads; that drift is
--     captured next cycle) and the second read is silently ignored.
--   - bigger difference → the deliberate re-read replaces the original.
-- Billing fires when the verification phase completes, not when the main
-- walk does. Only a re-read-confirmed below-previous value (rollover vs
-- meter-swap — a money decision) still escalates to the landlord queue.
--
-- Bundled here because they are one feature: the new 'double_check' run
-- status and the table that holds the phase's entries.
--
-- No backfill needed: existing completed runs never had the phase;
-- the single open demo run regenerates its list when its walk completes.

ALTER TABLE utility_reading_runs
    DROP CONSTRAINT utility_reading_runs_status_check;
ALTER TABLE utility_reading_runs
    ADD CONSTRAINT utility_reading_runs_status_check
    CHECK (status IN ('open', 'double_check', 'completed'));

CREATE TABLE utility_reading_double_checks (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    run_id        uuid NOT NULL REFERENCES utility_reading_runs(id) ON DELETE CASCADE,
    meter_id      uuid NOT NULL REFERENCES utility_meters(id) ON DELETE CASCADE,
    first_value   numeric NOT NULL,          -- the main-walk read at list generation
    is_suspicious boolean NOT NULL,          -- why it's on the list (NEVER sent to the reader)
    second_value  numeric,                   -- the re-read; NULL until entered
    outcome       text CHECK (outcome IN ('verified', 'replaced', 'escalated')),
    entered_by_user_id uuid REFERENCES users(id),
    entered_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id, meter_id)
);

CREATE INDEX idx_utility_reading_double_checks_run ON utility_reading_double_checks (run_id);
