-- S553: sales-call scheduling (one concern: the Portfolio Specialist call
-- funnel behind Lucy's leads).
--
-- Why: leads don't convert over email (Nic) — the second contact must be a
-- real-time call (video preferred: screen-share demo). Prospects book a
-- slot in-chat with Lucy from real availability; the Specialist works the
-- calls from the admin Leads page.
--
-- sales_call_availability: the Specialist's weekly recurring windows, in
-- the business timezone (SALES_CALL_TZ, default America/Phoenix — no DST).
-- Offered slots are 30-min increments inside active windows, next 14 days,
-- minus already-booked slots.
--
-- sales_call_slots: one row per BOOKED call. The partial unique index
-- enforces one booked call per start time (single Specialist at launch —
-- when there's a team, add a specialist column and widen the index).
--
-- No backfill needed: both tables are new. Seeded with a sensible default
-- availability (Mon-Fri 9:00-16:00) so booking works before anyone touches
-- the availability editor; the Specialist edits it in the admin portal.

CREATE TABLE sales_call_availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weekday int NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0=Sunday
  start_time time NOT NULL,
  end_time time NOT NULL CHECK (end_time > start_time),
  active boolean NOT NULL DEFAULT TRUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sales_call_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES sales_leads(id) ON DELETE SET NULL,
  starts_at timestamptz NOT NULL,
  duration_minutes int NOT NULL DEFAULT 30,
  mode text NOT NULL CHECK (mode IN ('video', 'phone')),
  status text NOT NULL DEFAULT 'booked'
    CHECK (status IN ('booked', 'completed', 'cancelled', 'no_show')),
  prospect_name text,
  prospect_email text,
  prospect_phone text,
  notes text,
  reminded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX sales_call_slots_booked_start_uniq
  ON sales_call_slots (starts_at) WHERE status = 'booked';
CREATE INDEX sales_call_slots_upcoming_idx
  ON sales_call_slots (starts_at) WHERE status = 'booked';

-- Default availability: Mon–Fri 9:00–16:00 business time.
INSERT INTO sales_call_availability (weekday, start_time, end_time)
VALUES (1,'09:00','16:00'),(2,'09:00','16:00'),(3,'09:00','16:00'),(4,'09:00','16:00'),(5,'09:00','16:00');
