-- S622: the late-fee terms a template states in PROSE.
--
-- Most leases print the late charge as words in a clause — "A late charge of
-- Five dollars ($5.00) per day shall be added to all Rent not received by the
-- due date" — with no blank for a field to attach to. Auto-placement can never
-- find it, so the drafting guard (which rightly insists the policy appear IN the
-- document, because courts enforce the document) saw a template with no
-- late-fee fields and refused to draft any lease at all.
--
-- The terms are in the document. They are simply not in a box. Reading them
-- satisfies the guard honestly, and lets the lease's own words drive what GAM
-- charges — which is the point of lease-is-law.
ALTER TABLE lease_templates
  ADD COLUMN IF NOT EXISTS late_fee_terms jsonb;
