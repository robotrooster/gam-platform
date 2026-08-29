-- S630 (Nic): route lease signing by PROPERTY, not by account.
--
-- "I wanna log in to my portfolio with one email, but when I get an email
--  saying there's a new draft lease that needs to be signed, I need it to go to
--  separate emails. Oak Park leases for Oak Park templates for Oak Park
--  property goes to my Oak Park email... That way whoever's managing the
--  account on-site can sign leases on behalf of me at that property without
--  having full access to all of my emails and all of my properties."
--
-- Today the landlord signer resolves landlords.user_id -> users.email. Nic's two
-- entities (Oak Park, Mountain View) share one login, so every lease from both
-- properties lands in one inbox and neither on-site manager can be given one
-- without handing over the other property's mail and the portal login too.
--
-- Deliberately NOT properties.office_email: that is published to guests (booking
-- quotes, the property-info agent tool). Whoever receives a signing link can
-- sign a lease as the landlord, so it must never be an address we hand out.
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS lease_signing_email text,
  -- Optional: who the on-site signer is, for the signature block. Left null the
  -- lease still shows the landlord's own name — delegating delivery is not the
  -- same as changing who the lease says signed it.
  ADD COLUMN IF NOT EXISTS lease_signing_name  text;

COMMENT ON COLUMN properties.lease_signing_email IS
  'Where landlord lease-signature requests and lease notifications for THIS property go. Falls back to the account email. Never shown to guests — see office_email for that.';
