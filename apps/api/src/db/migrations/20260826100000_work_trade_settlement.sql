-- S624 (Nic): work trade is PAID FORWARD, and it is settled in HOURS.
--
-- Nic, S623: "When you pay rent, you pay for the month that you're going to be
-- staying. So when you're working, those hours should be covering the month
-- that you're gonna be staying… people aren't gonna pay the first month and
-- then work. Why would they pay and then start working to build up an arrears
-- credit for the following month? If they just paid, they think, oh, I'm paid.
-- Why would I work?"
--
-- THE OLD MODEL, and why it had to go: the credit was computed AT INVOICE
-- GENERATION from approved hours in the month BEFORE the due date — work in
-- June, reduce July. That makes the first month of every work-trade tenancy
-- uncovered forever, and asks a tenant to pay before they have any reason to
-- work. September's hours do not exist on September 1st, so crediting a month
-- from its OWN hours cannot happen at generation. It has to be a MONTH-CLOSE
-- SETTLEMENT, which is what this table is.
--
-- THE LEDGER IS IN HOURS, NOT DOLLARS (Nic, S624): "if the agreement's eighty
-- hours, somebody only works sixty, twenty hours would carry forward, and then
-- next month they would have to work one hundred hours to be caught up."
--
-- A carried hour KEEPS ITS OWN MONTH'S VALUE. `hour_rate` is frozen at
-- settlement — basis ÷ target for THAT month — so a rent increase cannot
-- retroactively reprice labour someone already failed to do, and a tenant can
-- always know what an hour they skipped costs them. Revaluing carried hours at
-- whatever invoice they happen to land on would move an old debt silently.
--
-- SURPLUS BANKS WITHOUT LIMIT (Nic, S624). Deficits follow a tenant, so credits
-- must too, or the arrangement is asymmetric against the person doing the work.
-- Banked hours are still hours: they buy months, never cash. `banked_hours`
-- lives on the agreement because it is a single running figure, not a per-month
-- fact.
--
-- LENIENCY IS THE LANDLORD'S CALL (Nic, S624): "my two month rule was just an
-- example. If a landlord wants to give leniency for six months, they may choose
-- to do so or however long. But at some point, a landlord's gonna know that
-- somebody's never gonna be able to physically catch up. There's just not that
-- many hours in a month." Hence a per-agreement integer rather than the
-- hardcoded two months the first sketch had. The landlord may also end the
-- agreement by hand at any time; both paths settle the deficit identically.

ALTER TABLE work_trade_agreements
  ADD COLUMN IF NOT EXISTS banked_hours        numeric(8,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS carry_forward_months integer     NOT NULL DEFAULT 1;

COMMENT ON COLUMN work_trade_agreements.banked_hours IS
  'S624: hours worked beyond every obligation, carried forward without limit. Buys future months; never converts to cash.';
COMMENT ON COLUMN work_trade_agreements.carry_forward_months IS
  'S624: how many further month-closes a deficit may survive before it is billed in cash and the agreement ends. 0 = bill at the first close. Landlord-set.';

ALTER TABLE work_trade_agreements
  DROP CONSTRAINT IF EXISTS work_trade_banked_hours_nonneg;
ALTER TABLE work_trade_agreements
  ADD CONSTRAINT work_trade_banked_hours_nonneg CHECK (banked_hours >= 0);
ALTER TABLE work_trade_agreements
  DROP CONSTRAINT IF EXISTS work_trade_carry_forward_months_nonneg;
ALTER TABLE work_trade_agreements
  ADD CONSTRAINT work_trade_carry_forward_months_nonneg CHECK (carry_forward_months >= 0);

-- One row per agreement per calendar month. This is the audit record of what a
-- month asked for, what was worked, what was credited, and what is still owed
-- in hours — the thing that replaces Nic's paper: "I have people that do work
-- trade now that, some don't seem to do as much as others, and keeping track of
-- it all on paper is outdated."
CREATE TABLE IF NOT EXISTS work_trade_settlements (
  id             uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  agreement_id   uuid NOT NULL REFERENCES work_trade_agreements(id) ON DELETE CASCADE,
  invoice_id     uuid          REFERENCES invoices(id) ON DELETE SET NULL,
  -- The calendar month this settlement covers, stored as its first day.
  period_month   date NOT NULL,

  -- What the month asked for. PRORATED when the invoice was prorated (a move-in
  -- on the 20th bills 11/31 of the rent, so it asks 11/31 of the hours) — the
  -- percentage math only stays honest if the target moves with the bill.
  target_hours   numeric(8,2) NOT NULL,
  -- Approved logs dated inside this month. Recorded even when they end up
  -- applied elsewhere, because "what did they actually work in June" is a
  -- question the landlord asks independently of how it settled.
  hours_worked   numeric(8,2) NOT NULL DEFAULT 0,
  -- Hours credited AGAINST THIS MONTH, from any source: its own work, the bank,
  -- or a later month's surplus catching it up.
  hours_applied  numeric(8,2) NOT NULL DEFAULT 0,

  -- basis ÷ target, frozen. See the header.
  hour_rate      numeric(12,4) NOT NULL,
  -- The covered charges on this month's invoice, gross. The credit can never
  -- exceed it.
  basis_amount   numeric(12,2) NOT NULL,
  credit_applied numeric(12,2) NOT NULL DEFAULT 0,

  -- open    — hours still outstanding, still inside the leniency window
  -- settled — target met; nothing owed
  -- billed  — the leniency window closed with hours still owed; the remainder
  --           was charged in cash and the agreement ended
  status         text NOT NULL DEFAULT 'open',
  settled_at     timestamp with time zone,
  billed_at      timestamp with time zone,
  created_at     timestamp with time zone NOT NULL DEFAULT now(),
  updated_at     timestamp with time zone NOT NULL DEFAULT now(),

  CONSTRAINT work_trade_settlements_status_check
    CHECK (status = ANY (ARRAY['open','settled','billed'])),
  CONSTRAINT work_trade_settlements_target_positive CHECK (target_hours > 0),
  CONSTRAINT work_trade_settlements_hours_nonneg
    CHECK (hours_worked >= 0 AND hours_applied >= 0),
  -- A month can never be credited for more hours than it asked for. Surplus
  -- belongs to another month or to the bank, never here.
  CONSTRAINT work_trade_settlements_applied_within_target
    CHECK (hours_applied <= target_hours),
  CONSTRAINT work_trade_settlements_credit_nonneg
    CHECK (credit_applied >= 0 AND credit_applied <= basis_amount),
  CONSTRAINT work_trade_settlements_period_is_month_start
    CHECK (period_month = date_trunc('month', period_month)::date)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_work_trade_settlements_agreement_month
  ON work_trade_settlements (agreement_id, period_month);
-- The settlement job walks open months oldest-first to age deficits.
CREATE INDEX IF NOT EXISTS idx_work_trade_settlements_open
  ON work_trade_settlements (agreement_id, period_month) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_work_trade_settlements_invoice
  ON work_trade_settlements (invoice_id) WHERE invoice_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_updated_at_work_trade_settlements ON work_trade_settlements;
CREATE TRIGGER set_updated_at_work_trade_settlements
  BEFORE UPDATE ON work_trade_settlements
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
