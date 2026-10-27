-- Proof of income and the fixed-income question, for people who are already
-- residents.  (10/26, Nic.)
--
-- WHY.  Proof of income on the screening application only reaches people who
-- were screened. A resident invited by their landlord through the
-- previously-a-tenant flow never fills one in, and neither does anyone already
-- living here. Nic:
--
--   "For people that are already onboarded, proof of income needs to prompt
--    them in the tenant profile. Or if a person is invited as a previously was
--    a tenant onboard flow for landlords that can bypass that, it should also
--    ask them in the tenant portal after they're already signed up, NOT a
--    gatekeeping thing while they're trying to set up their password and
--    verify the email and all that stuff. We need to just ask it casually
--    later at like the first login when they're adding a payment method."
--
-- So this is never a gate. It is asked once they are in, beside the payment
-- method, and it can be ignored forever without blocking anything.
--
-- THE SURVEY IS ONE QUESTION, ANSWERED WITHOUT LEAVING THE PAGE:
--
--   "Maybe the survey could just literally be in the banner, like pop up on
--    their screen. Are you on fixed income? Yes or no? If yes, it takes them
--    to the descriptor of FlexPay. If they click no, then boom, they're just
--    flagged no, and it's done and over with right there without leaving the
--    page."
--
-- WHY A TABLE RATHER THAN AN ARRAY COLUMN.  GAM never erases, so a document
-- the resident replaces has to stay readable (removed_at), and each one needs
-- its own uploaded_at and original filename. An array of urls on `tenants`
-- could hold none of that.
--
-- WHY SELF-REPORTED IS SEPARATE FROM tenants.ssi_ssdi.  ssi_ssdi is the
-- VERIFIED flag an admin sets after reviewing income, and it gates FlexPay
-- enrollment. This column is what the person said about themselves in a
-- banner. Collapsing the two would let a tap on "Yes" qualify somebody for a
-- product that requires verification.
--
-- No backfill needed: a NULL answer means nobody has been asked yet, which is
-- true of everyone today.

CREATE TABLE IF NOT EXISTS tenant_income_documents (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- The gated serve path, never a public one (/api/tenants/income-files/:name).
  url          TEXT NOT NULL,
  filename     TEXT NOT NULL,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Soft delete: a replaced document stays readable. GAM never erases.
  removed_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_income_documents_tenant
  ON tenant_income_documents (tenant_id) WHERE removed_at IS NULL;
-- The serve route looks a file up by its url, so that lookup must be unique
-- and indexed; two rows for one url would make ownership ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS ux_tenant_income_documents_url
  ON tenant_income_documents (url);

COMMENT ON TABLE tenant_income_documents IS
  'Proof of income a resident attached in the tenant portal (10/26, Nic). Not a gate on anything; soft-deleted, never erased.';

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS fixed_income_self_reported BOOLEAN,
  ADD COLUMN IF NOT EXISTS fixed_income_asked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS fixed_income_answered_at TIMESTAMPTZ;

COMMENT ON COLUMN tenants.fixed_income_self_reported IS
  'What the resident said in the "Are you on fixed income?" banner. NULL = never answered. SELF-REPORTED ONLY — tenants.ssi_ssdi is the verified flag that gates FlexPay, and a tap here must never set it.';
COMMENT ON COLUMN tenants.fixed_income_asked_at IS
  'When the banner was last shown, so it is asked once and not every login.';
COMMENT ON COLUMN tenants.fixed_income_answered_at IS
  'When they answered either way. With a NULL answer and a non-NULL asked_at, they dismissed it.';
