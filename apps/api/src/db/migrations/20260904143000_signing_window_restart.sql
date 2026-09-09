-- S637 (Nic, DIRECTIVE): a slow tenant must not cost the landlord his signature.
--
--   "I just got an email saying the document has been autovoided because it was
--    not signed by all parties... resend the existing one. I'm not gonna
--    fucking sign it every time somebody fails to do their part on time. It
--    needs to be resent to them for signature."
--
-- Two Oak Park / Mountain View leases were voided today with the landlord's
-- signature already on them — RV 24 (Jonathan Busby never signed) and MH 25
-- (two of three signed, Annette Escandon outstanding). Voiding threw away work
-- that was done because of work that wasn't.
--
-- The 48-hour window still exists and still anchors on the landlord's signature
-- (S636: so a three-signer household cannot reset the clock at each relay hop).
-- What changes is what happens when it runs out: if the landlord has signed and
-- only TENANTS are outstanding, the document is RESENT to exactly those people
-- and the window restarts from here. Nobody re-signs anything.
--
-- Stored as its own column rather than by moving a signature timestamp: a
-- signature time is a fact about when somebody signed, and must never be edited
-- to manipulate a deadline.
ALTER TABLE lease_documents
  ADD COLUMN IF NOT EXISTS signing_window_restarted_at timestamptz;

COMMENT ON COLUMN lease_documents.signing_window_restarted_at IS
  'S637: when the 48h signing window was last restarted by resending to outstanding tenant signers. Anchors the auto-void clock alongside the landlord signature.';
