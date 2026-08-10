-- Demo booking (S596). The marketing "Book a demo" flow reuses the S553
-- sales-call slot engine rather than standing up a parallel booking system.
-- To let one engine serve multiple scheduling windows (product demos now,
-- signup-onboarding walkthroughs later) without a rewrite, both the
-- availability windows and the booked slots gain a `kind` discriminator.
--
-- Product decisions (Nic, S596): the sales/demo window is Mon-Fri 1:00-4:00 PM
-- America/Phoenix, 30-min cadence (six spots/day: 1:00 .. 3:30), each held as a
-- 20-min event so there is a 10-min gap between calls. The pre-existing
-- availability rows (an unconfirmed 9:00-16:00 window seeded in S553, zero
-- bookings ever taken) are repurposed to this decided window; operationally
-- the demo IS the sales call — one funnel, one calendar.
--
-- `meeting_url` stores the per-booking video room (self-hosted Jitsi; public
-- Jitsi until our stack is live). No backfill needed — zero existing slots.
--
-- Safe: additive columns with defaults; the availability DELETE+reseed only
-- touches config rows (no FK references, zero booked slots depend on them).

ALTER TABLE sales_call_availability
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'demo';
ALTER TABLE sales_call_availability
  DROP CONSTRAINT IF EXISTS sales_call_availability_kind_check;
ALTER TABLE sales_call_availability
  ADD CONSTRAINT sales_call_availability_kind_check
  CHECK (kind IN ('demo', 'onboarding'));

ALTER TABLE sales_call_slots
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'demo';
ALTER TABLE sales_call_slots
  DROP CONSTRAINT IF EXISTS sales_call_slots_kind_check;
ALTER TABLE sales_call_slots
  ADD CONSTRAINT sales_call_slots_kind_check
  CHECK (kind IN ('demo', 'onboarding'));
ALTER TABLE sales_call_slots
  ADD COLUMN IF NOT EXISTS meeting_url text;

-- Repurpose availability to the decided demo window: Mon-Fri 13:00-16:00.
-- weekday encoding matches the service's businessDate() map (Sun=0 .. Sat=6),
-- so 1..5 = Mon..Fri.
DELETE FROM sales_call_availability;
INSERT INTO sales_call_availability (weekday, start_time, end_time, kind, active)
SELECT d, TIME '13:00', TIME '16:00', 'demo', true
FROM generate_series(1, 5) AS d;
