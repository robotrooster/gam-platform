/**
 * 10/25 (Nic) — THE TRAILER INSTALLMENTS, OUT OF SQUARE AND INTO GAM.
 *
 *   "I need to add that installment contract under her name as well, so she gets
 *    both bills in this system, because the old ones were going to be still
 *    getting created in Square, and I don't want to do that anymore."
 *
 *   "I don't have original figures with me right now. This is just to get the
 *    payments flowing in the system. So show whatever payments balance is left
 *    in total."
 *
 * So these are MID-CONTRACT migrations, not new sales. There is no original sale
 * price or down payment to record, and none is invented: a flat plan with no
 * interest means sale_price = monthly × payments remaining, which IS the balance
 * left to collect. Recorded `active`, not pending_signature — both were signed
 * on paper long before GAM existed, and asking for a fresh signature on a
 * two-year-old agreement would be wrong.
 *
 * WHO IS HERE, and who is not:
 *
 *   Ivett Paredes, MH 19 — $312.04, 23 payments from 2026-11-01 to 2028-09-01.
 *     Nic: "Yvette does not need to be able to pay those separately. It's all or
 *     nothing." Her trailer payment rides her rent invoice, which is how GAM
 *     bills today, and that suits her.
 *
 *   Lisa Scheeler, MH 01 — $333.33, 34 payments from 2026-10-10 to 2029-07-10.
 *
 *     WHY 34 AND NOT THE 33 SQUARE SHOWS. Nic: "it's months going forward, but
 *     she has not paid October yet, which is the point that makes it 34. She's
 *     late on paying October because this isn't done yet. And if she had
 *     already paid October, then it would be 33... 34 includes [the] invoice
 *     due October 10th."
 *
 *     So Square's 33 is what remains AFTER October; the schedule has to carry
 *     the unpaid October 10 bill as well, which is installment 1 here. 34 x
 *     $333.33 = $11,333.22, last landing 2029-07-10 — Nic, after checking his
 *     books: "Not June of 2029, July 10th, 2029."
 *
 *     ("I had to cover something for her and it just went on the back end of
 *     her payments" — why the balance is what it is at all.)
 *
 *     This file is the record of that, not a thing to re-run: the
 *     guard below SKIPs any unit that already has a live contract, so a second
 *     --apply changes nothing. She is on work trade, so her rent is suspended
 *     and her invoice is the trailer payment ALONE — already built and tested
 *     (jobs/workTradeMonthlyRun.test: "a work-trade resident buying their home
 *     still owes the home payment").
 *
 *   Dominic Gonzalez, MH 25 — NOT in this script, deliberately. His $312.34 goes
 *     to the TRUST that owns the property while his space rent goes to the
 *     Mountain View LLC, so his needs its own invoice and must never be payable
 *     online or land in these books. GAM has no contract-level flag for that
 *     yet. Entering him now would bill him to the wrong account.
 *
 * DRY RUN BY DEFAULT.
 *   cd apps/api && npx ts-node -T src/scripts/oct25_migrate_trailer_contracts.ts
 *   cd apps/api && npx ts-node -T src/scripts/oct25_migrate_trailer_contracts.ts --apply
 */
import { queryOne, getClient } from '../db'

const MOUNTAIN_VIEW = '96ec7df3-362d-4777-b54c-e9604313820f'

const CONTRACTS = [
  { who: 'Ivett Paredes',  unit: 'MH 19', monthly: 312.04, payments: 23, startMonth: '2026-11-01',
    note: 'last bill 2028-09-01' },
  // 34, not Square's 33: Square's figure is what remains after October, and
  // October 10 is still unpaid — so it is installment 1 of 34 here.
  { who: 'Lisa Scheeler',  unit: 'MH 01', monthly: 333.33, payments: 34, startMonth: '2026-10-10',
    note: 'unpaid Oct 10 + the 33 Square shows; last lands 2029-07-10, $11,333.22' },
]

;(async () => {
  const apply = process.argv.includes('--apply')
  console.log(apply ? 'APPLYING\n' : 'DRY RUN — nothing is written\n')

  for (const c of CONTRACTS) {
    const row = await queryOne<any>(
      `SELECT u.id AS unit_id, l.id AS lease_id, t.id AS tenant_id,
              us.first_name || ' ' || us.last_name AS name
         FROM units u
         JOIN properties p ON p.id = u.property_id AND p.landlord_id = $1
         JOIN leases l ON l.unit_id = u.id AND l.status IN ('active','pending')
         JOIN lease_tenants lt ON lt.lease_id = l.id AND lt.status NOT IN ('void','removed')
         JOIN tenants t ON t.id = lt.tenant_id
         JOIN users us ON us.id = t.user_id
        WHERE u.unit_number = $2
          AND us.last_name ILIKE $3
        LIMIT 1`,
      [MOUNTAIN_VIEW, c.unit, c.who.split(' ').slice(-1)[0] + '%'])

    if (!row) { console.log(`SKIP ${c.who} (${c.unit}) — no live lease found for that name on that space`); continue }

    const balance = Math.round(c.monthly * c.payments * 100) / 100
    const live = await queryOne<any>(
      `SELECT id, status, monthly_payment FROM home_sale_contracts
        WHERE unit_id = $1 AND status IN ('active','pending_signature')`, [row.unit_id])
    if (live) {
      console.log(`SKIP ${row.name} (${c.unit}) — already has a ${live.status} contract at $${live.monthly_payment}`)
      continue
    }

    console.log(`${apply ? 'ADDING' : 'WOULD ADD'} ${row.name} · ${c.unit}`)
    console.log(`  $${c.monthly.toFixed(2)} × ${c.payments} from ${c.startMonth} — balance $${balance.toLocaleString()}`)
    console.log(`  ${c.note}`)
    if (!apply) continue

    const client = await getClient()
    try {
      await client.query('BEGIN')
      const { createHomeSaleContract } = await import('../services/homeSale')
      const made = await createHomeSaleContract(client as any, {
        unitId: row.unit_id, leaseId: row.lease_id, tenantId: row.tenant_id,
        landlordId: MOUNTAIN_VIEW,
        // Flat, no interest: the "sale price" IS the balance left to collect.
        // Nic has no original figures to hand and did not want them invented.
        salePrice: balance, downPayment: 0, annualInterestRate: 0,
        termMonths: c.payments, startMonth: c.startMonth, planType: 'flat',
        // Signed on paper years ago — not awaiting anything.
        pendingSignature: false,
      } as any)
      await client.query('COMMIT')
      console.log(`  ✓ contract ${made?.id ?? '(created)'}\n`)
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
  }
  if (!apply) console.log('\nNothing written. Re-run with --apply.')
  process.exit(0)
})().catch(e => { console.error(e?.message || e); process.exit(1) })
