-- S558 (Nic): smooth-onboarding pipeline state on pending_tenant_intents.
-- The new-lease onboard (Flow B) creates a unit-bound intent + sends the invite;
-- the lease auto-drafts once the unit's roster has accepted. Two columns track
-- that:
--   accepted_at      — stamped when the invited person accepts their invite
--                      (activates their portal account). The roster-close signal:
--                      when every unresolved intent on a unit is accepted, the
--                      lease auto-drafts.
--   draft_document_id — the auto-drafted lease_document once drafting fires;
--                      guards against re-drafting, and is cleared if that draft
--                      is voided (so adding a co-tenant + re-accepting re-drafts).
--                      ON DELETE SET NULL: a hard-deleted document just clears
--                      the pointer.
-- No backfill (feature pre-launch; existing intents are the import-pool flow).
ALTER TABLE public.pending_tenant_intents
  ADD COLUMN accepted_at timestamp with time zone,
  ADD COLUMN draft_document_id uuid
    REFERENCES public.lease_documents(id) ON DELETE SET NULL;
