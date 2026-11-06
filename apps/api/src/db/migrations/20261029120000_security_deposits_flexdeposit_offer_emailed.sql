-- 10/29 (Nic): the resident is told ONCE that their deposit can be split.
--
--   "We need the prompt to pop up for any tenants when the deposit has not
--    been paid yet... It needs to be there until the deposit is handled one
--    way or another."
--
-- The PORTAL prompt is the standing one and needs no record — it is computed
-- from the deposit's own state every time it is read, so it goes quiet on the
-- fact (funded, or a plan running) rather than on anything we store.
--
-- The EMAIL is the opposite: it must go exactly once, and the thing it is once
-- PER is the deposit, not the person — a resident who moves and owes a new
-- deposit at the next place is a new offer.
--
-- Why not email_send_log, which already records every send: jobs/complianceArchive
-- moves rows out of it to email_send_log_archive for every category that
-- email_log_is_permanent() does not name (only 'support_message' and
-- 'landlord_welcome_outreach' today). A "have we sent this?" check against that
-- table therefore starts answering NO again once the archive runs, and the
-- resident gets the same email a second time. The log stays the record of what
-- was sent; this column is the guard that decides whether to send.
--
-- No backfill needed: nothing has been sent, and a NULL means "not offered
-- yet", which is the right answer for every existing row.
ALTER TABLE security_deposits
  ADD COLUMN IF NOT EXISTS flexdeposit_offer_emailed_at TIMESTAMPTZ;

COMMENT ON COLUMN security_deposits.flexdeposit_offer_emailed_at IS
  '10/29: when the one-time "you can split this deposit" email went out for THIS deposit (jobs/flexDepositOfferEmail). NULL: never offered by email. The portal prompt is separate and standing — it is computed from the deposit''s state and records nothing.';
