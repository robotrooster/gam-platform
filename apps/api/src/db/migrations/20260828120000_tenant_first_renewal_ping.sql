-- S628 (Nic) — renewal is TENANT-FIRST.
--
-- S562 made it landlord-first: leases.landlord_renewal_offered_at gated the
-- tenant's renewal question, on the reasoning that there is no point asking a
-- tenant to stay if the landlord already plans to remodel. Nic has since
-- described the flow he actually wants the other way round — ping the TENANT at
-- 60 days, tell the LANDLORD at 32 — and asked directly this session, chose
-- tenant-first.
--
-- The reason is the clock. Both sides owe each other notice, the notice period
-- is set by state law and is commonly 30 or 60 days, and the person who knows
-- first whether they are staying is the person living there. Waiting for the
-- landlord to open the conversation means a tenant who has already decided to
-- leave says nothing until it is too late for anyone to act on — and the unit
-- sits empty for a month that a 60-day question would have prevented.
--
-- Two timestamps, both idempotence guards for the daily job rather than state
-- anybody reads for meaning:
--
--   tenant_renewal_pinged_at    — the tenant has been asked. Set once.
--   landlord_renewal_alerted_at — the landlord has been told where it stands
--                                 at ~32 days, whatever the tenant answered
--                                 (including "nothing yet", which is itself the
--                                 thing the landlord needs to know).
--
-- landlord_renewal_offered_at is NOT retired. It still means "the landlord has
-- made an offer", which is a real and separate event from "the tenant has been
-- asked". What changes is that it no longer GATES the question.

ALTER TABLE public.leases
  ADD COLUMN IF NOT EXISTS tenant_renewal_pinged_at    timestamp with time zone,
  ADD COLUMN IF NOT EXISTS landlord_renewal_alerted_at timestamp with time zone;

COMMENT ON COLUMN public.leases.tenant_renewal_pinged_at IS
  'S628: when the 60-day tenant-first renewal question was sent. Guard against re-asking.';
COMMENT ON COLUMN public.leases.landlord_renewal_alerted_at IS
  'S628: when the landlord was told where the renewal stands (~32 days out). Guard against repeat alerts.';
