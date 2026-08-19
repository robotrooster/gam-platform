-- S605 (Nic): a per-property designated lease signer.
--
-- "The property owner can assign it to an on-site manager, but it shouldn't go
-- to both people... limit that permission to only one user per property. And if
-- that person gets fired or removed from permission, then it defaults back to
-- the landlord or the owner."
--
-- Every e-sign path resolved the landlord signer as landlords.user_id — the
-- account owner, always. A landlord who had entitled an on-site manager with
-- leases.sign could let them OPEN the signing queue, but the document still
-- named the owner, so the manager could never actually be the counterparty.
--
-- ONE column, not a join table, precisely because the rule is one signer per
-- property. A table would permit two rows and make "who signs?" a question with
-- more than one answer — the ambiguity Nic is ruling out ("we don't need it to
-- accidentally send to two people, two people trying to sign at the same time").
--
-- ON DELETE SET NULL covers a deleted user. The commoner case — a manager who is
-- removed from the property or has leases.sign revoked but still has an account
-- — cannot be caught by a constraint, so entitlement is RE-VERIFIED every time a
-- signer is resolved and falls back to the owner when it no longer holds. The
-- column is an intent; the resolver is the authority.
--
-- NULL = the owner signs, which is the existing behaviour and the default for
-- every property. No backfill.

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS lease_signer_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN properties.lease_signer_user_id IS
  'S605: on-site manager designated to sign leases for this property, in place of the account owner. Exactly one. Entitlement is re-checked at signing time; NULL or an un-entitled user means the owner signs.';

CREATE INDEX IF NOT EXISTS idx_properties_lease_signer
  ON properties (lease_signer_user_id) WHERE lease_signer_user_id IS NOT NULL;
