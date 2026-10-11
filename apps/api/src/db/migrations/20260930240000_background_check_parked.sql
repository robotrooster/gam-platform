-- S653 (Nic): "for background checks that were approved that opted not to sign
-- a lease... keep them approved but mark them as dormant for now... so this
-- last one for Anastacio does not just forever say that it needs attention."
--
-- parked_at: the landlord set this approved applicant aside — not moving in
-- for now. The approval stands (expires_at is untouched); the check just
-- leaves the needs-attention list until it is un-parked or a lease exists.
ALTER TABLE background_checks
  ADD COLUMN parked_at timestamptz,
  ADD COLUMN parked_note text;
COMMENT ON COLUMN background_checks.parked_at IS 'S653: an approved applicant set aside — not moving in for now. Approval and expiry unchanged; off the needs-attention list until un-parked.';
