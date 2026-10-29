-- 10/26 (Nic) — A PROPERTY CHOOSES WHETHER CREDIT MAY BE SAVED UP.
--
-- Nic: "there needs to be a property level setting where landlords can choose
-- if people are allowed to save up credit ahead of time... Blue wants to have
-- his property set where any credit is automatically applied against the thing.
-- There's no saving it up."
--
-- ── WHAT WAS ALREADY TRUE ──────────────────────────────────────────────────
-- Most of what that asks for already runs, from Nic's 10/6 and 10/15 rulings:
--
--   • Credit a tenant already holds NEVER sits while they owe. It goes on the
--     open balance by itself, oldest bill first, whole or in part
--     (creditUse.drawCreditOnBalance, 10/15).
--   • That runs at the bill run, again right before any late fee is raised
--     (the bill is then re-qualified, so credit that covers it stops the fee),
--     and again whenever a credit is created.
--   • The bill the tenant receives already states the three figures: the
--     charges, one "Credit applied" line, and "Still owed"
--     (services/invoiceNotice + emailInvoiceReady, 10/6).
--
-- So "applied automatically", "cannot keep saving once late", "applied at grace
-- end whether or not it covers", and "show invoiced / credited / still owed"
-- are all live on every property already.
--
-- ── WHAT WAS LEFT, AND WHAT THIS COLUMN GOVERNS ────────────────────────────
-- One place still lets a tenant keep credit instead of spending it: the pay
-- screen's own question. When credit could pay part of what they are paying,
-- they are offered "Use all $X — pay $Y" or "Save it for later — pay $Z"
-- (Nic, 10/2). That second button is the save-up. With this FALSE the question
-- is not asked: the credit goes on the bill and they pay the rest.
--
-- DELIBERATELY NOT BLOCKED: banking an overpayment. A tenant who pays more
-- than they owe still has the surplus kept as paid-ahead credit, because GAM
-- cannot refuse part of money that has already arrived — a bank deposit lands
-- whole or not at all (the Bowmans' $10.40 came in exactly that way). That
-- surplus does not sit: the next bill run puts it on the new bill, which is
-- what "automatically applied" means. Refusing surplus would only strand it.
--
-- ── THE DEFAULT IS TODAY'S BEHAVIOR ────────────────────────────────────────
-- TRUE, so no property changes the day this lands and no tenant loses a choice
-- they were being offered. A landlord who wants Blue's arrangement turns it
-- off. Nic's standing rule on operating preferences: GAM accommodates how each
-- landlord runs their park rather than picking one operator's habits for all.
--
-- No backfill needed. Expand-only and re-runnable.

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS credit_save_up_allowed BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN properties.credit_save_up_allowed IS
  'FALSE: the pay screen never offers "Save it for later" — account credit goes
   on the bill being paid and the tenant pays the rest (Nic, 10/26). Credit
   already auto-applies to an open balance on every property regardless of this
   (10/15); this governs only the payer''s option to hold it back. An
   overpayment surplus is still banked and applied at the next bill run.';
