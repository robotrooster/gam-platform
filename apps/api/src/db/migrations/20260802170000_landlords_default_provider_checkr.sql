-- S577 — default new landlords to the live Checkr provider (Nic).
--
-- WHY: Checkr is live (keys wired). A landlord screens through Checkr only when
-- landlords.background_provider = 'checkr'; the column defaulted to 'mock'
-- (the S551 dev stub). Flip the DEFAULT so every NEW real landlord runs live
-- screening automatically. Existing rows are untouched — demo/test accounts
-- (james@demo.dev etc.) keep whatever they have ('mock'), so demos don't fire
-- real, billable Checkr orders.
--
-- CHECK constraint already allows ('mock','checkr'); only the default changes.

ALTER TABLE landlords ALTER COLUMN background_provider SET DEFAULT 'checkr';
