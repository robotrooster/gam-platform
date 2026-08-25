-- S622: conditional fees a TEMPLATE states in prose.
--
-- WHY: a fee written into a paragraph — "Upon move out, a fee of $100 will be
-- charged unless Tenant provides a receipt for professional carpet cleaning" —
-- has no blank, so field auto-placement can never find it. The IMPORT path
-- already reads these out of the text (detectConditionalFees, S550) and lands
-- them in lease_fees with condition_text set, never charging until a human
-- assesses the condition as failed at move-out.
--
-- Nic: "some leases are gonna be imported, scanned PDFs, and other ones are
-- gonna be electronic signature. It needs to work both ways universally — you
-- never know what a landlord is gonna choose to do with migrating." This is the
-- e-sign half: the same detector runs on the template PDF, the landlord confirms
-- what it found, and every lease sent from that template carries the condition.
--
-- Rows are landlord-confirmed, not raw detector output — the editor writes only
-- what was kept. condition_text is the clause VERBATIM (lease-is-law: the clause
-- is the authority, not our paraphrase of it).

CREATE TABLE IF NOT EXISTS lease_template_conditional_fees (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id    uuid NOT NULL REFERENCES lease_templates(id) ON DELETE CASCADE,
  label          text NOT NULL,
  amount         numeric(12,2) NOT NULL CHECK (amount > 0),
  condition_text text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_template_conditional_fees_template
  ON lease_template_conditional_fees (template_id);
