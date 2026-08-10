-- Demo booking (S596) — store the prospect's timezone.
--
-- The slot picker shows the prospect their LOCAL time (an East-Coast prospect
-- sees 5:00 PM for a 2:00 PM Arizona slot), so the confirmation + reminder
-- emails must echo the SAME local time — else they pick "5 PM" and the email
-- says "2 PM". We capture the browser's IANA timezone at booking and format the
-- prospect-facing copy in it. The owner-facing side (heads-up email, admin
-- list, calendar feed) stays Arizona. Nullable → older/unknown rows fall back
-- to Arizona. Also useful context for the rep ("this prospect is Eastern").
--
-- Safe: additive nullable column, no backfill needed.

ALTER TABLE sales_call_slots
  ADD COLUMN IF NOT EXISTS prospect_timezone text;
