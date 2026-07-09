-- Utility reading runs — the end-of-month meter-reading workflow (Nic's
-- designed flow, replacing the S531 manual record-reading/generate-bills
-- page; correction item #1 from the post-S531 walkthrough).
--
-- Product shape: on the LAST BUSINESS DAY of each month (walked backward
-- past weekends and US federal holidays), a run opens per property that
-- has readable meters (submeter/RUBS). Property staff + the landlord are
-- prompted to walk the meters and enter readings. Spots tied to a lease
-- where the lease says the tenant pays that utility get an automatic
-- usage calculation (current − prior reading × rate + base fee) and the
-- charge is added to that tenant's next monthly invoice (S178 rails).
-- When every meter in the run has a reading, the run auto-completes and
-- bills generate + finalize in one shot — no manual "Generate Bills".
--
-- One run per property per cycle (UNIQUE). Progress is DERIVED from
-- utility_meter_readings (no per-meter run rows to drift). bills_created
-- and billed_total are completion-time snapshots for the summary surface.
--
-- No backfill needed: runs only exist going forward; the daily scheduler
-- opens them.

CREATE TABLE utility_reading_runs (
    id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    property_id          uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    landlord_id          uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
    billing_cycle_month  date NOT NULL,  -- 1st of the month being read
    opened_on            date NOT NULL,  -- the computed last-business-day (or manual-open date)
    status               text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed')),
    completed_at         timestamptz,
    completed_by_user_id uuid REFERENCES users(id),
    bills_created        integer,
    billed_total         numeric(12,2),
    created_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (property_id, billing_cycle_month)
);

CREATE INDEX idx_utility_reading_runs_landlord ON utility_reading_runs (landlord_id, status);
CREATE INDEX idx_utility_reading_runs_open ON utility_reading_runs (property_id) WHERE status = 'open';
