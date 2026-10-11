-- S652 — THE PACKET IS SEEN, AND TRIMMED, AT THE INVITE.
--
-- Nic: "the invite packet should show up — how do I choose what's being added
-- to that invite for signature? It needs to show the packet at the invite."
-- The unit's default package is shown pre-ticked on the invite; the landlord
-- unticks what does not apply. What they left ticked rides on the intent so
-- the draft — at invite, on acceptance, or when a template lands — is exactly
-- that list. NULL = whatever the package suggests (the pre-S652 behaviour).
ALTER TABLE pending_tenant_intents ADD COLUMN IF NOT EXISTS package_template_ids uuid[];
