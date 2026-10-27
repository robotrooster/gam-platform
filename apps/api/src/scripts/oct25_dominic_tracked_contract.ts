/**
 * 10/25 (Nic) — DOMINIC GONZALEZ'S INSTALLMENT, TRACKED AND NEVER BILLED.
 *
 *   "For now, with Dominic, we are going to send reminders about that contract
 *    payment being due. But it is not going to go billed through the property.
 *    It's not going to get invoiced through the property. It's just going to be
 *    a ledger that keeps track and when that payment comes in, we will mark
 *    that it was paid, but it stays off the books."
 *
 * And, on being handed a switch to flip instead of a thing already right:
 *
 *   "It makes it sound like you're setting it up to be billed and I have to flip
 *    the switch to not have it invoice and take anything. That's not going to
 *    fly. I want you to build it already set up the way that it needs to be."
 *
 * So tracked_not_billed is set in the SAME transaction that creates the
 * contract. There is no moment, not even between two statements, when this
 * contract could be picked up by the biller.
 *
 * THE TERMS (Nic): $312.34 a month, MH 25 at Mountain View, first payment
 * November 2026 ("bill November for Yvette and Dominic"), last 2027-11-10 ("the
 * last payment is scheduled for November 10th, 2027"). 2026-11-10 through
 * 2027-11-10 inclusive is 13 payments, $4,060.42.
 *
 * WHY IT IS OFF THE BOOKS: the money is owed to the TRUST that owns the
 * property, not to the park. "His space rent gets billed to Mountain View and
 * the trailer payment would go to the trust." Invoicing it through the property
 * would put the trust's money on the park's books and then need unwinding.
 *
 * MH 25's home is already recorded as Dominic's (units.dwelling_ownership =
 * 'tenant'), which is correct — the sale happened before GAM, and GAM is
 * recording what is still owed on it, not financing a sale. That is why this
 * goes through the service rather than POST /api/home-sales, whose
 * assertUnitIsSaleable rightly refuses to "sell" a home the resident already
 * owns. The same path entered Ivett's and Lisa's.
 *
 * Run:  node -r ts-node/register apps/api/src/scripts/oct25_dominic_tracked_contract.ts [--apply]
 * Without --apply it reports and rolls back.
 */
import { getClient } from '../db'
import { createHomeSaleContract } from '../services/homeSale'

// Nic runs Mountain View and Oak Park ONLY; every write here is scoped to this
// one company so no other operator's park can ever be touched.
const MOUNTAIN_VIEW = '96ec7df3-362d-4777-b54c-e9604313820f'
const UNIT = 'MH 25'
const MONTHLY = 312.34
const PAYMENTS = 13          // 2026-11-10 … 2027-11-10 inclusive
const START = '2026-11-10'

;(async () => {
  const apply = process.argv.includes('--apply')
  const client = await getClient()
  try {
    await client.query('BEGIN')

    const unit = (await client.query<any>(
      `SELECT un.id AS unit_id, un.dwelling_ownership,
              l.id AS lease_id, v.tenant_id,
              usr.first_name || ' ' || usr.last_name AS who
         FROM units un
         JOIN properties pr ON pr.id = un.property_id
         JOIN leases l ON l.unit_id = un.id AND l.status = 'active'
         JOIN v_lease_active_tenants v ON v.lease_id = l.id AND v.role = 'primary'
         JOIN tenants t ON t.id = v.tenant_id
         JOIN users usr ON usr.id = t.user_id
        WHERE pr.landlord_id = $1 AND un.unit_number = $2`,
      [MOUNTAIN_VIEW, UNIT])).rows[0]
    if (!unit) throw new Error(`${UNIT} at Mountain View has no active lease with a primary resident`)
    if (!/dominic/i.test(unit.who)) {
      throw new Error(`${UNIT} is ${unit.who}, not Dominic — refusing to write a contract for the wrong person`)
    }

    const live = (await client.query<any>(
      `SELECT id, status FROM home_sale_contracts
        WHERE unit_id = $1 AND status IN ('active','pending_signature')`, [unit.unit_id])).rows[0]
    if (live) {
      console.log(`SKIP ${UNIT} — already has a ${live.status} contract (${live.id})`)
      await client.query('ROLLBACK')
      return
    }

    const made = await createHomeSaleContract(client as any, {
      unitId: unit.unit_id,
      leaseId: unit.lease_id,
      tenantId: unit.tenant_id,
      landlordId: MOUNTAIN_VIEW,
      salePrice: Math.round(MONTHLY * PAYMENTS * 100) / 100,
      downPayment: 0,
      annualInterestRate: 0,
      termMonths: PAYMENTS,
      startMonth: START,
      planType: 'flat',
      pendingSignature: false,
    } as any)

    // THE POINT OF THIS SCRIPT: tracked before the transaction ever commits, so
    // the biller can never see it as billable.
    await client.query(
      `UPDATE home_sale_contracts SET tracked_not_billed = TRUE, updated_at = NOW() WHERE id = $1`,
      [made.id])

    const check = (await client.query<any>(
      `SELECT c.tracked_not_billed, c.installments_total, c.monthly_payment, c.sale_price,
              MIN(i.billing_month)::text AS first_bill, MAX(i.billing_month)::text AS last_bill,
              SUM(i.amount) AS total
         FROM home_sale_contracts c JOIN home_sale_installments i ON i.contract_id = c.id
        WHERE c.id = $1 GROUP BY 1,2,3,4`, [made.id])).rows[0]

    console.log(`${unit.who} — ${UNIT}`)
    console.log(`  tracked (never billed): ${check.tracked_not_billed}`)
    console.log(`  ${check.installments_total} x $${Number(check.monthly_payment).toFixed(2)} = $${Number(check.total).toFixed(2)}`)
    console.log(`  first ${check.first_bill} · last ${check.last_bill}`)
    console.log(`  home already the resident's: ${unit.dwelling_ownership === 'tenant'}`)

    if (apply) {
      await client.query('COMMIT')
      console.log('APPLIED')
    } else {
      await client.query('ROLLBACK')
      console.log('DRY RUN — nothing written. Re-run with --apply.')
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error(e)
    process.exitCode = 1
  } finally {
    client.release()
  }
})()
