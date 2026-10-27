-- 10/25 — THE 48-HOUR RE-SEND HAD NO CEILING, AND IT SHOWED.
--
-- Nic: "I don't know how many emails we've fired for October... I feel like it's
-- a lot." It was, and almost none of it was notifications.
--
-- processEsignTimeouts re-sends the signing REQUEST for a document that has sat
-- 48 hours with the landlord signed, then stamps invite_sent_at = NOW() — which
-- makes it 48 hours stale again two days later. An unbounded loop.
--
-- On the live database: Jolyn Whitfield received 108 signing requests in October
-- and Kyra Smith 108, nine documents each, every two days since 10/02. Those two
-- people alone were 216 of the month's 367 e-sign emails, and 28% of every email
-- GAM sent. September came to 3,215 emails, over Resend's free tier.
--
-- This is the SAME failure mode S639 already fixed one block higher up, for the
-- 2-hour nudge: "952 emails to 39 people over eight days — about eighty to one
-- resident... Once a day, five times, then stop. Somebody who has ignored five
-- daily reminders is not going to sign because of a sixth; they need a phone
-- call, and the document auto-voids anyway." The reasoning transfers word for
-- word, so the ceiling is the same shape rather than a new number of mine.
--
-- reminder_count is the nudge path's counter and stays its own; a re-send of the
-- request is a different act with a different cadence, so it gets its own.
--
-- NO BACKFILL. Starting every signer at 0 gives the people currently in the loop
-- five more asks at most instead of forever, which is the point. The two above
-- are handled by hand in the same pass.
ALTER TABLE lease_document_signers
  ADD COLUMN IF NOT EXISTS invite_resend_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN lease_document_signers.invite_resend_count IS
  'How many times the 48-hour timeout path has re-sent this signer their signing request. Capped (see processEsignTimeouts) so a document nobody signs stops emailing rather than asking forever.';
