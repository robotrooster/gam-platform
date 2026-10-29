-- 10/17 (Nic), reading the admin nexus page: "the sales tax nexus on the admin
-- platform is not accurately reading... it would need to take into account any
-- margins that GAM makes on card payments or ACH payments." And what he wants
-- to see per state: "a breakdown of total transactions, and then the actual
-- subscription costs, hard markup fees, background checks or screenings, and
-- then any other customer opt-in things, the credit reporting and stuff like
-- that. Let's have them all as a combined total on the Nexus by default, but
-- then we can expand it and see line items and see, okay, if that state's not
-- counting some of those, where are we really at? I'd rather count high and
-- register with those states early."
--
-- The nightly tally kept ONE dollar figure per state-year, summed from four
-- subscription-shaped sources, and GAM's processing markup was not one of them
-- — so every state read low by the whole card/ACH margin. The tally now reads
-- GAM's revenue book (platform_revenue_ledger, the real per-charge margin —
-- memories gam-one-book-for-gam-revenue + gam-book-is-actual-fees) and keeps
-- each line item beside the total, so the page can show one number by default
-- and open it up when a state measures only part of it.
--
-- revenue_usd stays the COMBINED total (its own non-negative CHECK predates
-- this, so it is floored at zero); the line items below are signed, because a
-- take-back or a monthly processing true-up can push one of them negative and
-- the state's figure has to stay traceable to the book.
--
-- Expand only. No backfill needed: the nightly job (and the Recompute button)
-- overwrite every state-year row from scratch.
ALTER TABLE nexus_revenue_tally
  ADD COLUMN IF NOT EXISTS subscription_usd numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS markup_usd       numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS screening_usd    numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS optin_usd        numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS other_usd        numeric(14,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN nexus_revenue_tally.subscription_usd IS
  '10/17 (Nic) "the actual subscription costs": what customers pay GAM to be on the platform in this state — the per-space monthly fee from GAM''s revenue book, plus the business portal''s monthly fee, which has never been posted to the book.';
COMMENT ON COLUMN nexus_revenue_tally.markup_usd IS
  '10/17 (Nic) "hard markup fees": GAM''s real margin on each card and bank payment, as the revenue book recorded it per charge — never a rate-table estimate.';
COMMENT ON COLUMN nexus_revenue_tally.screening_usd IS
  '10/17 (Nic) "background checks or screenings": GAM''s margin on each screening, measured where the applicant lives.';
COMMENT ON COLUMN nexus_revenue_tally.optin_usd IS
  '10/17 (Nic) "any other customer opt-in things, the credit reporting and stuff like that": FlexPay today; anything else a customer opts into as it starts earning.';
COMMENT ON COLUMN nexus_revenue_tally.other_usd IS
  'Everything else GAM earned in this state that the four named line items do not cover (card-reader markup, placement fees, a new revenue type nobody has slotted yet). Counted by default so a new way of earning money can never quietly drop out of a state''s measure.';
COMMENT ON COLUMN nexus_revenue_tally.revenue_usd IS
  'The COMBINED total of the line items beside it (floored at zero — the pre-existing non-negative CHECK). Nic, 10/17: "I''d rather count high and register with those states early."';
