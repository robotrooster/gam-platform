-- S607 (Nic, DIRECTIVE): drop the autopay late-fee projection.
--
-- Nic: "it doesn't seem like autopay needs to be that big of a deal. They choose
-- the date, and it pays in full whatever the balance is on the account. If late
-- fees are accruing daily, it just reads the outstanding amount at the time
-- payment is set to go through. We don't need to make it all complicated and
-- show somebody what their bill will be exactly trying to calculate it out."
--
-- Correct on both counts. The column stored a SNAPSHOT of a moving number:
-- between the tenant choosing a day and the charge landing, the balance changes
-- for entirely ordinary reasons — another accrual tick, a utility bill joining
-- the invoice, a waived fee — so any figure captured in advance is a promise the
-- system cannot keep. Reading the live balance at charge time is simpler and
-- always right.
--
-- What the tenant is told instead is true without being falsely precise: picking
-- a day after the due date means late fees per their lease, and the charge is the
-- full outstanding balance at the moment it runs.
--
-- SAFE: added earlier in this same session, never populated, never read. The
-- guard below refuses to drop it if that is somehow untrue.

DO $$
DECLARE n integer;
BEGIN
  SELECT COUNT(*) INTO n FROM tenant_autopay WHERE projected_late_fee_cents IS NOT NULL;
  IF n > 0 THEN
    RAISE EXCEPTION 'Refusing to drop projected_late_fee_cents: % row(s) hold a value.', n;
  END IF;
END $$;

ALTER TABLE tenant_autopay DROP COLUMN IF EXISTS projected_late_fee_cents;

COMMENT ON TABLE tenant_autopay IS
  'S607: tenant-scheduled rent autopay. The pull day is the TENANT''S choice and no landlord route may write to this table — a landlord able to move the date could manufacture late fees. Charges the full outstanding balance read live at run time; nothing is forecast.';
