-- S639: signing reminders were being sent every two hours, indefinitely.
--
-- Measured on the live database before this change: 952 reminder emails to 39
-- people, running at ~140 a day for eight days straight. One resident (Dakota
-- Lane, RV 18) had received about eighty. The rule read "landlord is done:
-- nudge this tenant every 2 hours" with no ceiling and no end, so anybody who
-- did not sign was mailed roughly every couple of hours for as long as the
-- document stayed open.
--
-- That is not a reminder, it is harassment, and it is the fastest way to have
-- goldassetmanagement.com marked as a spam sender — which would take down the
-- invites, the receipts and the signing requests along with it. Nobody in the
-- onboarding batch can sign a lease if our mail stops being delivered.
--
-- reminder_count lets the sender space them out and then stop.
ALTER TABLE lease_document_signers
  ADD COLUMN IF NOT EXISTS reminder_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN lease_document_signers.reminder_count IS
  'S639: how many signing reminders this signer has been sent. Capped so a document that is never signed stops mailing the person instead of nudging forever.';

-- Everyone already reminded is at or past the cap; this stops the current
-- flood on the next scheduler tick rather than after another day of it.
UPDATE lease_document_signers
   SET reminder_count = 99
 WHERE reminder_sent_at IS NOT NULL
   AND status <> 'signed';
