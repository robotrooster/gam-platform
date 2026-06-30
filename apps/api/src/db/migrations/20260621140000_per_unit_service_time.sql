-- Per-unit service time + efficiency (service-business, S510).
--
-- WHY: a stop's expected time scales with how much work is there — Nic's
-- "1 minute per can, 10 cans = 10 minutes". The owner sets a per-unit
-- rate; each customer carries a unit count (e.g. # cans, also used for
-- billing). expected = rate × units becomes the stop's service time for
-- routing AND the benchmark we compare real on-site time against for
-- efficiency tracking.
--
-- businesses.service_seconds_per_unit: owner rate (default 60 = 1 min).
-- businesses.service_unit_label: noun for UI copy ("can", "bin", "unit").
-- business_customers.unit_count: standing quantity per customer.
-- route_stops.expected_seconds: snapshot of rate × units at route build
--   time (so later rate/count edits don't rewrite history). Nullable —
--   dump/depot stops have none. No backfill needed.

ALTER TABLE businesses
  ADD COLUMN service_seconds_per_unit integer NOT NULL DEFAULT 60
    CHECK (service_seconds_per_unit >= 0),
  ADD COLUMN service_unit_label text NOT NULL DEFAULT 'unit';

ALTER TABLE business_customers
  ADD COLUMN unit_count integer NOT NULL DEFAULT 1
    CHECK (unit_count >= 0);

ALTER TABLE route_stops
  ADD COLUMN expected_seconds integer;
