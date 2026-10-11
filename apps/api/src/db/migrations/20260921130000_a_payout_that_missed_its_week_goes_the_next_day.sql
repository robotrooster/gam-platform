-- S652 — A PAYOUT THAT MISSED ITS WEEK GOES OUT THE NEXT WEEKDAY.
--
-- Mountain View's September 16 batch ($4,154.89) could not transfer that week:
-- some of its payments had not become available at Stripe yet. Saturday's fix
-- (44ce61e) retried the transfer and it landed on September 19 — into Mountain
-- View's Stripe balance. But the BANK payout only fires on the weekly day, so the
-- money sat there, available, with the next payout a week away. Nic, Monday:
-- "where did that four thousand dollars go?"
--
-- The payout job now pays a late-landed transfer out on the next weekday run,
-- and records that payout as 'catch_up' so the five-day spacing rule does not
-- then skip the regular weekly payout that follows.
--
-- No backfill needed.

ALTER TABLE disbursements DROP CONSTRAINT disbursements_trigger_type_check;
ALTER TABLE disbursements ADD CONSTRAINT disbursements_trigger_type_check
  CHECK (trigger_type IS NULL OR trigger_type = ANY (ARRAY['auto_friday','manual_on_demand','otp_legacy','catch_up']));
