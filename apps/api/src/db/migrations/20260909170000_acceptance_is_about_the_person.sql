-- S639 round two (Nic): "you're still showing the pending pool as three people
-- not invited yet. Iliana Gonzalez, Glenda Greek, and Dakota Lane... Glenda has
-- not signed her lease, but I have signed my end of her lease. And the creation
-- of that lease tells me that she accepted the invite."
--
-- He is right on both counts, and the second is enforced in code:
-- leaseOnboarding.autoDraftLeasesForUnit only drafts once
-- roster.every(m => m.accepted_at), so a lease document existing IS proof every
-- person named on it accepted their invite.
--
-- What the first pass got wrong: acceptance was read off the USER
-- (tenant_invite_accepted_at), when pending_tenant_intents.accepted_at — on the
-- very row the pool displays — had recorded it all along. Glenda and Dakota both
-- had it stamped on 2026-09-02 while the pool called them uninvited.
--
-- Acceptance is a fact about a PERSON, not about one invite row. Somebody with
-- two invites (their unit, plus the screening-waiver audit row) must not have
-- two different answers to "did they ever get in".
UPDATE users u
   SET tenant_invite_accepted_at = e.accepted_at
  FROM (SELECT t.user_id, MIN(pti.accepted_at) AS accepted_at
          FROM pending_tenant_intents pti
          JOIN tenants t ON t.id = pti.tenant_id
         WHERE pti.accepted_at IS NOT NULL
         GROUP BY t.user_id) e
 WHERE u.id = e.user_id
   AND u.tenant_invite_accepted_at IS NULL;

-- A lease document naming somebody is the other proof. Uses the document's own
-- creation time, which is the earliest moment we can show they had accepted.
UPDATE users u
   SET tenant_invite_accepted_at = e.first_doc
  FROM (SELECT s.user_id, MIN(d.created_at) AS first_doc
          FROM lease_document_signers s
          JOIN lease_documents d ON d.id = s.document_id
         WHERE s.user_id IS NOT NULL
         GROUP BY s.user_id) e
 WHERE u.id = e.user_id
   AND u.role = 'tenant'
   AND u.tenant_invite_accepted_at IS NULL;
