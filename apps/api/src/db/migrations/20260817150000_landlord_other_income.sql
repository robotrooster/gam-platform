-- S605 (Nic): other income — money in that GAM didn't collect.
--
-- Nic, looking at the bank review queue: "should we be able to choose a drop
-- down option for income as well... because if the only option is to ignore it,
-- why are we even showing it on this page?"
--
-- He's right, and the gap was real. The feed only let money-OUT be categorized;
-- every inbound row that wasn't a recognized GAM payout could only be Ignored.
-- But a landlord has real income GAM never touches — laundry and vending,
-- storage or propane sales, an insurance claim, a tax refund, rent handed over
-- in cash and deposited, an owner contribution. Ignoring all of it means the
-- P&L reports expenses in full and income only partially: it understates profit
-- and is wrong on the exact number the landlord cares most about.
--
-- Mirrors landlord_expenses deliberately (same scoping, same is_common
-- allocation, same void-not-delete posture) so the P&L can treat the two sides
-- symmetrically and anyone who understands one table understands the other.
--
-- Rent and other GAM-collected money must NEVER be recorded here — that income
-- already reaches the P&L from `payments`, and duplicating it would double-count
-- the landlord's revenue. Enforced in the service: only a bank transaction that
-- auto-matching did NOT tie to a GAM disbursement can land here.
--
-- No backfill: previously-ignored inbound rows stay ignored. They can be
-- re-reviewed from the Ignored tab if a landlord wants them counted.

CREATE TABLE IF NOT EXISTS landlord_other_income (
  id                uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
  landlord_id       uuid NOT NULL REFERENCES landlords(id) ON DELETE CASCADE,
  property_id       uuid REFERENCES properties(id) ON DELETE SET NULL,
  unit_id           uuid REFERENCES units(id) ON DELETE SET NULL,
  category          text NOT NULL,
  amount            numeric(12,2) NOT NULL CHECK (amount > 0),
  description       text,
  payer             text,
  income_date       date NOT NULL,
  is_common         boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','voided')),
  voided_at         timestamptz,
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_landlord_other_income_landlord_date
  ON landlord_other_income (landlord_id, income_date DESC) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_landlord_other_income_property
  ON landlord_other_income (property_id) WHERE status = 'active';

COMMENT ON TABLE landlord_other_income IS
  'S605: landlord income GAM did not collect (laundry, vending, insurance claims, cash rent deposited). Feeds the P&L income side alongside payments. NEVER holds GAM-collected rent — that would double-count.';

-- Link back to the bank row that produced it, matching how expenses do it, so a
-- P&L figure can always be traced to the bank transaction behind it.
ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS landlord_other_income_id uuid
    REFERENCES landlord_other_income(id) ON DELETE SET NULL;
