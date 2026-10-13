-- 10/12 (Nic): PAID EXTRA HOURS — what the landlord owes a work trader for
-- hours beyond the trade, on an agreement set to pay them
-- (work_trade_agreements.extra_hours_mode = 'pay').
--
-- One record per agreement per closed period while it is unpaid: the month
-- close writes the hours, the rate and the pay method in force at that close,
-- and the amount (hours x rate). A later close that counts more of that
-- period's hours (an approval that landed after the close) adds them to the
-- same unpaid record at the same rate; nothing is ever counted twice, because
-- the close counts each approved hour once (S654).
--
-- Nic, 10/12, how it gets paid: "Both." The landlord either
--   - pays by hand and presses Mark paid (paid_how check/cash, paid_on, note), or
--   - presses Send to GAM Books, which queues it for GAM Books payroll (W-2) or
--     contractor payment (1099). books_reference_id stays NULL until GAM Books
--     picks it up (the Books-side pickup is a follow-up; GAM Books is being
--     rebuilt in parallel).
--
-- Keep-everything: never deleted. Values match @gam/shared
-- WORK_TRADE_EXTRA_PAY_METHODS, WORK_TRADE_EXTRA_PAYABLE_STATUSES and
-- WORK_TRADE_EXTRA_PAID_HOW.
--
-- Expand-only. New table, no backfill.
CREATE TABLE IF NOT EXISTS work_trade_extra_hours (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- RESTRICT (the default): money owed for work done is never erased from
  -- under its agreement.
  agreement_id        uuid NOT NULL REFERENCES work_trade_agreements(id),
  landlord_id         uuid NOT NULL REFERENCES landlords(id),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  -- The period whose close produced these hours. SET NULL rather than block:
  -- a renewal re-draws its still-open months (services/renewalSuccessor), and
  -- what is owed for hours already worked must outlive that.
  settlement_id       uuid REFERENCES work_trade_settlements(id) ON DELETE SET NULL,
  period_month        date NOT NULL,
  period_start        date NOT NULL,
  hours               numeric(8,2) NOT NULL,
  rate                numeric(10,2) NOT NULL,
  amount              numeric(12,2) NOT NULL,
  pay_method          text NOT NULL,
  status              text NOT NULL DEFAULT 'unpaid',
  paid_on             date,
  paid_how            text,
  paid_note           text,
  paid_by             uuid REFERENCES users(id),
  paid_at             timestamptz,
  sent_to_books_at    timestamptz,
  sent_to_books_by    uuid REFERENCES users(id),
  books_reference_id  uuid,
  created_at          timestamptz NOT NULL DEFAULT NOW(),
  updated_at          timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT work_trade_extra_hours_hours_positive CHECK (hours > 0),
  CONSTRAINT work_trade_extra_hours_rate_positive CHECK (rate > 0),
  CONSTRAINT work_trade_extra_hours_amount_nonneg CHECK (amount >= 0),
  CONSTRAINT work_trade_extra_hours_pay_method_check
    CHECK (pay_method IN ('payroll_w2', 'contractor_1099')),
  CONSTRAINT work_trade_extra_hours_status_check
    CHECK (status IN ('unpaid', 'sent_to_books', 'paid')),
  CONSTRAINT work_trade_extra_hours_paid_how_check
    CHECK (paid_how IS NULL OR paid_how IN ('check', 'cash')),
  -- A paid record says when it was paid; an unpaid one says nothing of the kind.
  CONSTRAINT work_trade_extra_hours_paid_is_stamped
    CHECK ((status = 'paid') = (paid_at IS NOT NULL)),
  CONSTRAINT work_trade_extra_hours_sent_is_stamped
    CHECK (status <> 'sent_to_books' OR sent_to_books_at IS NOT NULL)
);

-- At most one UNPAID record per agreement, period, rate and pay method: the
-- month close merges late-counted hours into it (ON CONFLICT repeats this
-- predicate). A paid or sent record is never reopened.
CREATE UNIQUE INDEX IF NOT EXISTS work_trade_extra_hours_one_unpaid
  ON work_trade_extra_hours (agreement_id, period_start, rate, pay_method)
  WHERE status = 'unpaid';

CREATE INDEX IF NOT EXISTS work_trade_extra_hours_landlord_status
  ON work_trade_extra_hours (landlord_id, status);
CREATE INDEX IF NOT EXISTS work_trade_extra_hours_agreement
  ON work_trade_extra_hours (agreement_id, period_start);

COMMENT ON TABLE work_trade_extra_hours IS
  '10/12 (Nic): paid extra hours — approved work-trade hours beyond what a month and any carried shortfall needed, on an agreement set to pay them. Written by the month close; paid by hand (Mark paid) or queued for GAM Books (Send to GAM Books). Never deleted.';
COMMENT ON COLUMN work_trade_extra_hours.books_reference_id IS
  '10/12: the GAM Books payroll run or contractor payment that paid this record. NULL until GAM Books picks up a sent_to_books record (follow-up).';
