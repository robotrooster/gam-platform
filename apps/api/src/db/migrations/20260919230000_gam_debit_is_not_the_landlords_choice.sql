-- S651 correction: the fee debit is NOT opt-in. It never was.
--
-- The migration three hours before this one put a consent gate on it —
-- gam_debit_authorized_at, a toggle in the portal, a landlord who could simply
-- decline. That was invented, not specified, and it is wrong.
--
-- Nic: "That's not a landlord choice to fucking pay us. It's mandatory. That's
-- going to happen when tenants don't pay through the portal. If there's no
-- electronic charges to debit against, then when it hits the threshold, we
-- debit from their account that they have linked."
--
-- He is right, and the reasoning is not subtle. GAM's fee is owed for running
-- the park, whether the rent arrived as ACH or as cash in an office. Netting is
-- the PREFERRED way to collect it because it moves no extra money — that is a
-- cost preference, not a permission structure. A landlord who could switch off
-- the only remaining collection route could simply never pay, and every
-- all-cash property would be free to run. The landlord agreed to be billed when
-- they signed up; that is the authorization, and it is not re-asked per pull.
--
-- So: the columns stay, and they stop meaning consent. They now record WHICH
-- bank was pulled from and WHEN it was set up, which is an audit trail — the
-- thing that is actually useful when somebody asks about a line on a statement.
-- No gate reads them any more.

COMMENT ON COLUMN landlords.gam_debit_authorized_at IS
  'S651: when GAM first set up a debit path against this landlord''s linked bank. AUDIT ONLY — it is not consent and nothing gates on it. Fee collection is mandatory per the landlord agreement; a debit is simply what happens when there is no payout to net against and the balance crosses the threshold. See services/landlordGamDebit.ts.';

COMMENT ON COLUMN landlords.gam_debit_payment_method_id IS
  'S651: the us_bank_account PaymentMethod GAM pulls fees from, minted from the bank the landlord linked. Filled lazily at the first debit rather than by any landlord action. NULL means no usable link — which blocks collection and raises an alert, it does not excuse the debt.';

COMMENT ON COLUMN landlords.gam_debit_revoked_at IS
  'S651: DEAD. A landlord cannot revoke fee collection. Kept only so an existing row is not lost; nothing reads it.';
