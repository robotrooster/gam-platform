-- Backfill security_deposits rows for existing leases (S515).
--
-- WHY. Before S515 nothing in production created security_deposits rows —
-- the live deposit was only a lease_fees row (fee_type='security_deposit'),
-- so FlexDeposit custody, deposit portability, OTP deposits, interest
-- accrual, and deposit-return all read a table that was never populated
-- outside tests. S515 wires creation into syncSecurityDepositLeaseFee going
-- forward; this migration backfills the rows for leases that already have a
-- deposit fee but no security_deposits row.
--
-- held_by mirrors the property's deposit_handling_mode ('landlord_held' →
-- 'landlord', 'gam_escrow' → 'gam_escrow'). Rows start status='pending';
-- the settle path / FlexDeposit overlay advance them from there. Leases
-- with no active primary tenant are skipped (tenant_id is NOT NULL) — a
-- later fee-sync or move-in will create the row once a tenant is attached.
-- Existing security_deposits rows are left untouched (NOT EXISTS guard), so
-- this is safe to re-run and never clobbers FlexDeposit / portability state.

BEGIN;

WITH dep AS (
  SELECT lease_id, MAX(amount) AS amount
    FROM lease_fees
   WHERE fee_type = 'security_deposit'
     AND due_timing = 'move_in'
     AND amount > 0
   GROUP BY lease_id
)
INSERT INTO security_deposits (unit_id, lease_id, tenant_id, total_amount, status, held_by)
SELECT l.unit_id, l.id, t.tenant_id, dep.amount, 'pending',
       CASE WHEN p.deposit_handling_mode = 'landlord_held'
            THEN 'landlord' ELSE 'gam_escrow' END
  FROM dep
  JOIN leases l      ON l.id = dep.lease_id
  JOIN units u       ON u.id = l.unit_id
  JOIN properties p  ON p.id = u.property_id
  JOIN LATERAL (
    SELECT vlat.tenant_id
      FROM v_lease_active_tenants vlat
     WHERE vlat.lease_id = l.id AND vlat.role = 'primary'
     LIMIT 1
  ) t ON TRUE
 WHERE NOT EXISTS (
   SELECT 1 FROM security_deposits sd WHERE sd.lease_id = l.id
 );

COMMIT;
