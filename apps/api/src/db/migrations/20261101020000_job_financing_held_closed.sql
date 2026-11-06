-- The contractor marketplace launches; financing a job does NOT.
--
-- 10/31 (Nic): "I think we launch the contractor stuff now just have financing
-- jobs off. We still take 3 percent... Reserve pool comes later."
--
-- Financing is built and tested — the price card, the 25%-of-flat-rent
-- affordability rule, and the arithmetic of what GAM has to front. What is NOT
-- decided is where the reserve pool's money comes from, and until it is, a
-- quote GAM cannot fund must not be quotable. On a $10,000 job over four
-- payments GAM fronts $7,023.75 on the day the job finishes; ten at once needs
-- about $70,200 standing by.
--
-- The switch is a platform flag and not a per-landlord setting, because a
-- feature is platform-wide: one row here answers for everybody, and flipping it
-- is the launch rather than a migration.
--
-- Default FALSE. services/jobFinancing.canFinance refuses while it is off, so
-- the refusal is in the service every quote runs through rather than on a
-- route — financing has no HTTP door yet, and this is what makes sure it cannot
-- grow one that is live by accident.
--
-- No backfill: one new row in a table that already exists.

INSERT INTO system_features (key, enabled, description)
VALUES (
  'job_financing_enabled',
  FALSE,
  'Financing a contractor-marketplace job over 2, 4, 6 or 12 payments. OFF until the reserve pool is funded — GAM fronts about 70% of a four-payment job on the day it finishes. The marketplace itself and GAM''s 3% of a finished job are NOT gated by this and launch without it. ON = a landlord can be quoted a payment plan.'
)
ON CONFLICT (key) DO NOTHING;
