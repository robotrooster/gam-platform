/**
 * S624 — the zero-touch path, and the guards that keep it narrow.
 *
 * This is the ONLY place GAM settles a tenant's rent with nobody in the loop, so
 * what it REFUSES matters more than what it accepts. It overrides the S570
 * design lock ("landlord always confirms") on the strength of two independent
 * signals agreeing — a tenant's declaration and a bank row — neither of which is
 * the landlord's guess. Anything less than that must fall back to a shortlist.
 *
 * The failure this prevents is specific and bad: in a park where every lot pays
 * the same rent, settling on amount alone books one tenant's money onto
 * another's ledger and then onto their credit file.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { autoSettleDeclaredDeposits, autoSettleByAmount, reconcileDeposits, namesAPayer, normalizeMerchant } from './bankFeed'
import { undoDepositMatch } from './bankDepositConfirm'
import { memoNameTokens, memoNamesTenant, memoNamesOnlyTenant, isTenantCheckMemo, BANK_BOILERPLATE_WORDS } from './bankDepositMatch'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease,
  seedLeaseTenant,
} from '../test/dbHelpers'

beforeEach(cleanupAllSchema)

interface Park {
  landlordId: string; connectionId: string; propertyId: string
  lots: Array<{ tenantId: string; leaseId: string; unitId: string; rentId: string }>
}

/** A park where every lot pays the same rent — the hard case, by design. */
async function buildPark(lots: number, rent = 250): Promise<Park> {
  const client = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId, ownerUserId: userId, managedByUserId: userId })
    const conn = (await client.query(
      `INSERT INTO bank_connections (landlord_id, provider, status)
       VALUES ($1,'stripe_fc','active') RETURNING id`, [landlordId])).rows[0]

    const out: Park['lots'] = []
    for (let i = 0; i < lots; i++) {
      const tenantId = await seedTenant(client)
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: rent })
      await client.query(`UPDATE units SET unit_number=$2 WHERE id=$1`,
        [unitId, `Lot ${i + 1}`])
      const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: rent })
      await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
      const rentId = (await client.query(
        `INSERT INTO payments
           (unit_id, lease_id, tenant_id, landlord_id, type, amount, status,
            due_date, entry_description)
         VALUES ($1,$2,$3,$4,'rent',$5,'pending',CURRENT_DATE,'RENT') RETURNING id`,
        [unitId, leaseId, tenantId, landlordId, rent.toFixed(2)])).rows[0].id
      out.push({ tenantId, leaseId, unitId, rentId })
    }
    return { landlordId, connectionId: conn.id, propertyId, lots: out }
  } finally { client.release() }
}

async function deposit(p: Park, amount: number, description: string) {
  return (await db.query(
    `INSERT INTO bank_transactions
       (bank_connection_id, landlord_id, external_id, posted_date, amount,
        description, status)
     VALUES ($1,$2,$3,CURRENT_DATE,$4,$5,'needs_review') RETURNING id`,
    [p.connectionId, p.landlordId, randomUUID(), amount.toFixed(2), description])).rows[0].id
}

async function declareFor(p: Park, i: number, amount: number, method = 'cash') {
  const lot = p.lots[i]
  return (await db.query(
    `INSERT INTO tenant_declared_deposits
       (tenant_id, lease_id, landlord_id, amount, declared_date, method)
     VALUES ($1,$2,$3,$4,CURRENT_DATE,$5) RETURNING id`,
    [lot.tenantId, lot.leaseId, p.landlordId, amount.toFixed(2), method])).rows[0].id
}

const rentStatus = async (id: string) => (await db.query(
  `SELECT status FROM payments WHERE id=$1`, [id])).rows[0].status

describe('two independent signals settle without a human', () => {
  it('settles the declaring tenant, and only them, in an identical-rent park', async () => {
    const p = await buildPark(25)
    await declareFor(p, 6, 250)
    await deposit(p, 250, 'ATM CASH DEPOSIT')

    const n = await autoSettleDeclaredDeposits(p.landlordId)
    expect(n).toBe(1)
    expect(await rentStatus(p.lots[6].rentId)).toBe('settled')
    // Every other lot is untouched — this is the whole safety property.
    for (const [i, lot] of p.lots.entries()) {
      if (i === 6) continue
      expect(await rentStatus(lot.rentId)).toBe('pending')
    }
  })

  it('marks the declaration confirmed and the bank row matched', async () => {
    const p = await buildPark(3)
    const dId = await declareFor(p, 0, 250)
    const tId = await deposit(p, 250, 'ATM CASH DEPOSIT')
    await autoSettleDeclaredDeposits(p.landlordId)

    const d = (await db.query(
      `SELECT status, bank_transaction_id FROM tenant_declared_deposits WHERE id=$1`,
      [dId])).rows[0]
    expect(d.status).toBe('confirmed')
    expect(d.bank_transaction_id).toBe(tId)
    const t = (await db.query(
      `SELECT status FROM bank_transactions WHERE id=$1`, [tId])).rows[0]
    expect(t.status).toBe('matched')
  })
})

describe('what it refuses to do alone', () => {
  it('will not settle when two tenants both declared the same figure', async () => {
    const p = await buildPark(25)
    await declareFor(p, 3, 250, 'cash')
    await declareFor(p, 11, 250, 'cash')
    await deposit(p, 250, 'ATM CASH DEPOSIT')
    // Ambiguous between the two claimants — a human picks.
    expect(await autoSettleDeclaredDeposits(p.landlordId)).toBe(0)
    expect(await rentStatus(p.lots[3].rentId)).toBe('pending')
    expect(await rentStatus(p.lots[11].rentId)).toBe('pending')
  })

  it('ignores a deposit that matches no claim', async () => {
    const p = await buildPark(5)
    await declareFor(p, 0, 250)
    await deposit(p, 900, 'ATM CASH DEPOSIT')
    expect(await autoSettleDeclaredDeposits(p.landlordId)).toBe(0)
  })

  it('never reaches another landlord’s deposits', async () => {
    const a = await buildPark(2)
    const b = await buildPark(2)
    await declareFor(b, 0, 250)
    await deposit(b, 250, 'ATM CASH DEPOSIT')
    expect(await autoSettleDeclaredDeposits(a.landlordId)).toBe(0)
    expect(await rentStatus(b.lots[0].rentId)).toBe('pending')
  })

  it('is safe to run twice — a settled deposit is not settled again', async () => {
    const p = await buildPark(3)
    await declareFor(p, 0, 250)
    await deposit(p, 250, 'ATM CASH DEPOSIT')
    expect(await autoSettleDeclaredDeposits(p.landlordId)).toBe(1)
    expect(await autoSettleDeclaredDeposits(p.landlordId)).toBe(0)
    const settled = await db.query(
      `SELECT COUNT(*)::int AS n FROM payments
        WHERE lease_id=$1 AND type='rent' AND status='settled'`, [p.lots[0].leaseId])
    expect(settled.rows[0].n).toBe(1)
  })
})

// S655 HIGH (decisions #11, money plan leftovers): a tenant's report used to
// settle their WHOLE open balance whatever the deposit — the matcher fell back
// to every open charge when no set added up. A report settles only charges
// that add up to it to the cent; anything else waits for the landlord with
// "covers $X of $Y owed".
describe('a report settles only what adds up to it, to the cent', () => {
  it('never settles a report that adds up to no set of the tenant’s charges', async () => {
    const p = await buildPark(1)
    const lot = p.lots[0]
    const old = (await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'carried_balance',500,'pending','2026-01-01','BALANCE') RETURNING id`,
      [lot.unitId, lot.leaseId, lot.tenantId, p.landlordId])).rows[0].id
    await declareFor(p, 0, 300)
    const txn = await deposit(p, 300, 'ATM CASH DEPOSIT')
    expect(await autoSettleDeclaredDeposits(p.landlordId)).toBe(0)
    expect(await rentStatus(lot.rentId)).toBe('pending')
    expect(await rentStatus(old)).toBe('pending')
    expect((await db.query(`SELECT status FROM bank_transactions WHERE id=$1`, [txn])).rows[0].status).toBe('needs_review')
  })

  it('settles exactly the charges that add up to the report and leaves the rest open', async () => {
    const p = await buildPark(1)
    const lot = p.lots[0]
    const water = (await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'utility',40,'pending',CURRENT_DATE,'UTILITY') RETURNING id`,
      [lot.unitId, lot.leaseId, lot.tenantId, p.landlordId])).rows[0].id
    await declareFor(p, 0, 250)
    await deposit(p, 250, 'ATM CASH DEPOSIT')
    expect(await autoSettleDeclaredDeposits(p.landlordId)).toBe(1)
    expect(await rentStatus(lot.rentId)).toBe('settled')
    expect(await rentStatus(water)).toBe('pending')
  })
})

// ── S655 (money plan §3, Step 12): auto-settle by amount ─────────────────────
//
// Nic (10/2): "auto-settle a tenant's own bank deposit that equals exactly one
// tenant's whole open bill to the cent with nothing else fitting (Undo + notice
// to both sides; same for a check memo naming the tenant with an exact amount)".
// This flips S624's "never on amount alone" — narrowly.

const txnStatus = async (id: string) => (await db.query(
  `SELECT status, auto_settled_at IS NOT NULL AS auto FROM bank_transactions WHERE id=$1`, [id])).rows[0]

async function addLine(p: Park, i: number, type: string, amount: number, entry: string) {
  const lot = p.lots[i]
  return (await db.query(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',CURRENT_DATE,$7) RETURNING id`,
    [lot.unitId, lot.leaseId, lot.tenantId, p.landlordId, type, amount.toFixed(2), entry])).rows[0].id
}

async function waitFor<T>(f: () => Promise<T | null | undefined>, ms = 2000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const v = await f()
    if (v) return v
    if (Date.now() > until) throw new Error('timed out waiting')
    await new Promise(r => setTimeout(r, 25))
  }
}

describe('Step 12: a deposit nobody reported settles a tenant’s whole bill by itself', () => {
  it('settles a tenant’s whole bank-payable bill to the cent when nothing else fits', async () => {
    const p = await buildPark(1)
    const water = await addLine(p, 0, 'utility', 41.25, 'UTILITY')
    const home = await addLine(p, 0, 'home_payment', 200, 'HOMEPMT')
    const t = await deposit(p, 491.25, 'BRANCH DEPOSIT')
    expect(await autoSettleByAmount(p.landlordId)).toBe(1)
    for (const id of [p.lots[0].rentId, water, home]) expect(await rentStatus(id)).toBe('settled')
    expect(await txnStatus(t)).toEqual({ status: 'matched', auto: true })
  })

  it('a rival bill, a pending report or a same-amount deposit within 4 days stops it', async () => {
    // A rival: two tenants each owe exactly $250.
    const rival = await buildPark(2)
    const t1 = await deposit(rival, 250, 'BRANCH DEPOSIT')
    expect(await autoSettleByAmount(rival.landlordId)).toBe(0)
    expect((await txnStatus(t1)).status).toBe('needs_review')

    // Part of a bill is not the whole bill.
    const part = await buildPark(1)
    await addLine(part, 0, 'utility', 40, 'UTILITY')
    await deposit(part, 250, 'BRANCH DEPOSIT')
    expect(await autoSettleByAmount(part.landlordId)).toBe(0)
    expect(await rentStatus(part.lots[0].rentId)).toBe('pending')

    // A report from this household (of another amount) is the tenant's own story to check.
    const reported = await buildPark(1)
    await declareFor(reported, 0, 300)
    await deposit(reported, 250, 'BRANCH DEPOSIT')
    expect(await autoSettleByAmount(reported.landlordId)).toBe(0)
    expect(await rentStatus(reported.lots[0].rentId)).toBe('pending')

    // Someone else reported a deposit of this amount.
    const other = await buildPark(2)
    await db.query(`UPDATE payments SET amount = 999 WHERE id = $1`, [other.lots[1].rentId])
    await declareFor(other, 1, 250)
    await deposit(other, 250, 'BRANCH DEPOSIT')
    expect(await autoSettleByAmount(other.landlordId)).toBe(0)
    expect(await rentStatus(other.lots[0].rentId)).toBe('pending')

    // Two deposits of the same amount within 4 days: which is whose?
    const twice = await buildPark(1)
    await deposit(twice, 250, 'BRANCH DEPOSIT')
    await db.query(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status)
       VALUES ($1,$2,$3,CURRENT_DATE - 3,250,'BRANCH DEPOSIT','categorized')`,
      [twice.connectionId, twice.landlordId, randomUUID()])
    expect(await autoSettleByAmount(twice.landlordId)).toBe(0)
    expect(await rentStatus(twice.lots[0].rentId)).toBe('pending')
  })

  it('a check memo naming the tenant with the exact amount settles', async () => {
    const p = await buildPark(3)
    await db.query(`UPDATE users SET last_name = 'Garcia' WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`,
      [p.lots[1].tenantId])
    const t = await deposit(p, 250, 'REMOTE DEP CHK R GARCIA')
    expect(await autoSettleByAmount(p.landlordId)).toBe(1)
    expect(await rentStatus(p.lots[1].rentId)).toBe('settled')
    expect(await rentStatus(p.lots[0].rentId)).toBe('pending')
    expect(await rentStatus(p.lots[2].rentId)).toBe('pending')
    expect((await txnStatus(t)).auto).toBe(true)
    const method = (await db.query(`SELECT manual_method FROM payments WHERE id=$1`, [p.lots[1].rentId])).rows[0].manual_method
    expect(method).toBe('check')
  })

  it('both sides are told', async () => {
    const p = await buildPark(1)
    await deposit(p, 250, 'BRANCH DEPOSIT')
    expect(await autoSettleByAmount(p.landlordId)).toBe(1)
    const tenantUser = (await db.query(`SELECT user_id FROM tenants WHERE id=$1`, [p.lots[0].tenantId])).rows[0].user_id
    const owner = (await db.query(`SELECT user_id FROM landlords WHERE id=$1`, [p.landlordId])).rows[0].user_id
    const tn = await waitFor(async () => (await db.query(`SELECT title, body FROM notifications WHERE user_id=$1`, [tenantUser])).rows[0])
    expect(tn.title).toBe('Your bank deposit has been applied')
    expect(tn.body).toMatch(/^We applied your \$250\.00 deposit of \d{4}-\d{2}-\d{2} to your bill — it matched what you owed to the cent\./)
    const ln = await waitFor(async () => (await db.query(`SELECT title, body, action_url FROM notifications WHERE user_id=$1`, [owner])).rows[0])
    expect(ln.title).toBe('A bank deposit was applied to rent by itself')
    expect(ln.body).toMatch(/was auto-applied — it was exactly one tenant’s whole bill and nothing else fit\. If that is wrong, press Undo/)
  })

  it('an auto-applied deposit can be undone, and is never applied by itself again', async () => {
    const p = await buildPark(1)
    const t = await deposit(p, 250, 'BRANCH DEPOSIT')
    expect(await autoSettleByAmount(p.landlordId)).toBe(1)
    await undoDepositMatch({ bankTransactionId: t, landlordId: p.landlordId, undoneBy: null })
    expect(await rentStatus(p.lots[0].rentId)).toBe('pending')
    expect((await txnStatus(t)).status).toBe('needs_review')
    expect(await autoSettleByAmount(p.landlordId)).toBe(0)
    expect((await reconcileDeposits(p.landlordId)).autoSettled).toBe(0)
    expect(await rentStatus(p.lots[0].rentId)).toBe('pending')
  })

  it('a payout from a rent channel or another named payer never settles a bill on amount alone', async () => {
    const p = await buildPark(1)
    await deposit(p, 250, 'ST-B9S6S4F0D0I0 DOORLOOP CORPORATE ACH')
    await deposit(p, 250, 'Square Inc       SQ261001   261001 T3H80F2ZQ67M')
    // (Two deposits of $250 would stop it anyway; each is checked alone too.)
    await db.query(`UPDATE bank_transactions SET posted_date = CURRENT_DATE - 9 WHERE description LIKE 'Square%'`)
    expect(await autoSettleByAmount(p.landlordId)).toBe(0)
    expect(await rentStatus(p.lots[0].rentId)).toBe('pending')
  })

  it('a deposit made before the bill existed never pays it by itself', async () => {
    const p = await buildPark(1)
    const t = await deposit(p, 250, 'BRANCH DEPOSIT')
    await db.query(`UPDATE bank_transactions SET posted_date = CURRENT_DATE - 12 WHERE id = $1`, [t])
    expect(await autoSettleByAmount(p.landlordId)).toBe(0)
    expect(await rentStatus(p.lots[0].rentId)).toBe('pending')
  })

  // S655 leftover (Steps 9 and 12): a settle that is neither Stripe nor credit
  // writes how it was paid, so an old failed card intent never reads as GAM-held.
  it('an auto-settled move-in box row over an old failed intent becomes landlord-funded paid-ahead money', async () => {
    const p = await buildPark(1)
    await db.query(`UPDATE payments SET status = 'settled', settled_at = now(), manual_method = 'cash' WHERE id = $1`, [p.lots[0].rentId])
    const lot = p.lots[0]
    const fee = (await db.query<{ id: string }>(
      `INSERT INTO lease_fees (lease_id, fee_type, amount, due_timing, money_kind, is_refundable)
       VALUES ($1,'other_fee',300,'move_in','prepaid',FALSE) RETURNING id`, [lot.leaseId])).rows[0].id
    const box = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date,
                             entry_description, revenue_owner, lease_fee_id, stripe_payment_intent_id)
       VALUES ($1,$2,$3,$4,'fee',300,'failed',CURRENT_DATE,'OTHERFEE','held',$5,'pi_old_card') RETURNING id`,
      [lot.unitId, lot.leaseId, lot.tenantId, p.landlordId, fee])).rows[0].id
    await deposit(p, 300, 'BRANCH DEPOSIT')
    expect(await autoSettleByAmount(p.landlordId)).toBe(1)
    expect((await db.query(`SELECT status, manual_method, platform_held FROM payments WHERE id=$1`, [box])).rows[0])
      .toMatchObject({ status: 'settled', manual_method: 'cash', platform_held: false })
    const credit = (await db.query(
      `SELECT funded_by, amount_original::float AS amount FROM lease_prepaid_credits WHERE source_payment_id=$1`, [box])).rows
    expect(credit).toEqual([{ funded_by: 'landlord', amount: 300 }])
  })
})

// Step 12 review (fix round 1): the named-check settle read names out of memos
// that were not a tenant's check. Production memo shapes, verbatim in form.
const SQUARE_MEMO = 'Square Inc       SQ260803   260803 T5CSP2MKBFF8M4 Meryl Rhoades'
const BRANCH_MEMO = 'eDeposit in Branch 09/15/26 02:31:45 PM 360 W CONTINENTAL RD GREEN VALLEY AZ'

async function nameTenant(p: Park, i: number, first: string, last: string) {
  await db.query(`UPDATE users SET first_name = $2, last_name = $3 WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`,
    [p.lots[i].tenantId, first, last])
}

describe('Step 12: a memo that is not a tenant’s check never settles a named tenant', () => {
  it('a Square payout naming its account holder never settles a tenant named the same', async () => {
    expect(isTenantCheckMemo(SQUARE_MEMO, 'Nicholas Rhoades')).toBe(false)
    const p = await buildPark(1)
    await nameTenant(p, 0, 'Nicholas', 'Rhoades')
    const t = await deposit(p, 250, SQUARE_MEMO)
    expect(await autoSettleByAmount(p.landlordId)).toBe(0)
    expect(await rentStatus(p.lots[0].rentId)).toBe('pending')
    expect((await txnStatus(t)).status).toBe('needs_review')
  })

  it('a branch deposit’s street address never names a tenant', async () => {
    expect(memoNameTokens(BRANCH_MEMO)).toEqual([])
    expect(memoNamesTenant(BRANCH_MEMO, 'Pat Green')).toBe(false)
    expect(memoNamesTenant(BRANCH_MEMO, 'Valley Smith')).toBe(false)
    // Two tenants owe the same $250 and one is a Green: the address must not
    // pick her out, so the deposit waits for the landlord.
    const p = await buildPark(2)
    await nameTenant(p, 0, 'Pat', 'Green')
    const t = await deposit(p, 250, BRANCH_MEMO)
    expect(await autoSettleByAmount(p.landlordId)).toBe(0)
    expect(await rentStatus(p.lots[0].rentId)).toBe('pending')
    expect(await rentStatus(p.lots[1].rentId)).toBe('pending')
    expect((await txnStatus(t)).status).toBe('needs_review')
  })

  it('a reference number never leaves letters that spell a name', () => {
    expect(memoNameTokens(SQUARE_MEMO)).toEqual(['SQUARE', 'MERYL', 'RHOADES'])
    expect(memoNamesTenant('Square Inc SQ261001 261001 T3ANN80F2ZQ67M', 'Ann Lee')).toBe(false)
    expect(memoNameTokens('ST-B9S6S4F0D0I0 DOORLOOP CORPORATE ACH')).toEqual(['DOORLOOP', 'CORPORATE'])
  })

  it('the payer reader and the name reader share one list of bank words', () => {
    // Step 12 fix round 2: one list (bankDepositMatch.BANK_BOILERPLATE_WORDS).
    // Every word in it says how money came in, so a memo of only those words
    // names no payer AND no tenant.
    for (const w of BANK_BOILERPLATE_WORDS) {
      expect(namesAPayer(w), w).toBe(false)
      expect(memoNameTokens(`MOBILE DEPOSIT ${w}`), w).toEqual([])
    }
    for (const w of ['MADE', 'A', 'NUMBER', 'NBR', 'CAPTURE', 'INSTANT', 'INC', 'SQ']) {
      expect(BANK_BOILERPLATE_WORDS.has(w), w).toBe(true)
    }
    expect(memoNameTokens('DEPOSIT MADE IN A BRANCH/STORE CHECK')).toEqual([])
    // The bank paying interest is a payer, but never a tenant.
    expect(namesAPayer(normalizeMerchant('INTEREST PAYMENT'))).toBe(true)
    expect(memoNameTokens('INTEREST PAYMENT')).toEqual([])
  })

  it('only a check-shaped memo naming the tenant and nobody else is that tenant’s check', () => {
    expect(isTenantCheckMemo('REMOTE DEP CHK R GARCIA', 'Rosa Garcia')).toBe(true)
    expect(isTenantCheckMemo('MOBILE DEPOSIT REF NUMBER ROSA GARCIA', 'Rosa Garcia')).toBe(true)
    // Names someone else too.
    expect(memoNamesOnlyTenant('MOBILE DEPOSIT MERYL RHOADES', 'Nicholas Rhoades')).toBe(false)
    expect(isTenantCheckMemo('MOBILE DEPOSIT MERYL RHOADES', 'Nicholas Rhoades')).toBe(false)
    // Not a check: a plain deposit, a cash deposit, a branch deposit.
    expect(isTenantCheckMemo('DEPOSIT GARCIA', 'Rosa Garcia')).toBe(false)
    expect(isTenantCheckMemo('ATM CASH DEPOSIT GARCIA', 'Rosa Garcia')).toBe(false)
    expect(isTenantCheckMemo('EDEPOSIT IN BRANCH GARCIA', 'Rosa Garcia')).toBe(false)
  })

  it('a check memo that also names someone else waits for the landlord', async () => {
    const p = await buildPark(1)
    await nameTenant(p, 0, 'Nicholas', 'Rhoades')
    // Not anonymous either, so it is not an amount-only settle.
    await deposit(p, 250, 'MOBILE DEPOSIT MERYL RHOADES')
    expect(await autoSettleByAmount(p.landlordId)).toBe(0)
    expect(await rentStatus(p.lots[0].rentId)).toBe('pending')
  })
})
