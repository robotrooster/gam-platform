/**
 * S624 — the zero-touch path, and the guards that keep it narrow. 10/14 (Nic,
 * answer 16: "no guessing"): a tenant's report and a bank row no longer settle
 * rent with nobody in the loop — the report is picked on the deposit review and
 * a person confirms it. What the matcher REFUSES to pick still matters more than
 * what it picks: anything less than a report that adds up, with no rival, must
 * fall back to a shortlist with nothing picked.
 *
 * The failure this prevents is specific and bad: in a park where every lot pays
 * the same rent, settling on amount alone books one tenant's money onto
 * another's ledger and then onto their credit file.
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db, getClient } from '../db'
import { reconcileDeposits, namesAPayer, normalizeMerchant } from './bankFeed'
import { undoDepositMatch, confirmDepositMatch } from './bankDepositConfirm'
import { candidatesForDeposit } from './bankDepositCandidates'
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

// 10/14 (Nic, answer 16): "if gam 100 percent knows who that money came from it
// can file it but no guessing." Confirmed: "Exact matches file themselves (GAM
// payouts, front-desk-logged deposits for the exact amount); anything that
// would be a guess asks." A tenant's report and a bank row of the same amount
// are the tenant's claim, not GAM knowing who paid: the report is PICKED on the
// deposit review for the person to confirm (candidate preselect), and only the
// person's confirm settles it. The guards below decide what is picked.

/** The report-backed candidate picked for the person on this line, or undefined. */
const picked = async (t: string) => (await offered(t)).find(c => c.preselect && c.declaration)

/** The person confirms the picked report (the deposit review's Confirm). */
async function confirmPicked(t: string) {
  const c = await picked(t)
  expect(c, 'a report should be picked for the person').toBeTruthy()
  return confirmDepositMatch({
    bankTransactionId: t, chargeIds: c!.chargeIds, method: 'cash', declarationId: c!.declaration!.id, confirmedByUserId: null,
  })
}

describe('a tenant’s report and the bank row: picked for the person, never settled without one', () => {
  it('picks the declaring tenant, and only them, in an identical-rent park; nothing settles until the person confirms', async () => {
    const p = await buildPark(25)
    await declareFor(p, 6, 250)
    const t = await deposit(p, 250, 'ATM CASH DEPOSIT')

    const r = await reconcileDeposits(p.landlordId)
    expect(r.recorded + r.slips + r.payouts).toBe(0)
    for (const lot of p.lots) expect(await rentStatus(lot.rentId)).toBe('pending')
    expect((await picked(t))?.chargeIds).toEqual([p.lots[6].rentId])

    await confirmPicked(t)
    expect(await rentStatus(p.lots[6].rentId)).toBe('settled')
    // Every other lot is untouched — this is the whole safety property.
    for (const [i, lot] of p.lots.entries()) {
      if (i === 6) continue
      expect(await rentStatus(lot.rentId)).toBe('pending')
    }
  })

  it('the person’s confirm marks the declaration confirmed and the bank row matched', async () => {
    const p = await buildPark(3)
    const dId = await declareFor(p, 0, 250)
    const tId = await deposit(p, 250, 'ATM CASH DEPOSIT')
    await reconcileDeposits(p.landlordId)
    expect((await db.query(`SELECT status FROM tenant_declared_deposits WHERE id=$1`, [dId])).rows[0].status).toBe('pending')
    await confirmPicked(tId)

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

describe('what it never picks', () => {
  it('two tenants both declared the same figure: neither is picked', async () => {
    const p = await buildPark(25)
    await declareFor(p, 3, 250, 'cash')
    await declareFor(p, 11, 250, 'cash')
    const t = await deposit(p, 250, 'ATM CASH DEPOSIT')
    // Ambiguous between the two claimants — a human picks.
    await reconcileDeposits(p.landlordId)
    expect(await picked(t)).toBeUndefined()
    expect(await rentStatus(p.lots[3].rentId)).toBe('pending')
    expect(await rentStatus(p.lots[11].rentId)).toBe('pending')
  })

  it('a deposit that matches no claim', async () => {
    const p = await buildPark(5)
    await declareFor(p, 0, 250)
    const t = await deposit(p, 900, 'ATM CASH DEPOSIT')
    await reconcileDeposits(p.landlordId)
    expect(await picked(t)).toBeUndefined()
  })

  it('never reaches another landlord’s deposits', async () => {
    const a = await buildPark(2)
    const b = await buildPark(2)
    await declareFor(b, 0, 250)
    const t = await deposit(b, 250, 'ATM CASH DEPOSIT')
    await reconcileDeposits(a.landlordId)
    await reconcileDeposits(b.landlordId)
    expect(await rentStatus(b.lots[0].rentId)).toBe('pending')
    expect((await db.query(`SELECT status FROM bank_transactions WHERE id=$1`, [t])).rows[0].status).toBe('needs_review')
  })

  it('a deposit the person confirmed is not settled again', async () => {
    const p = await buildPark(3)
    await declareFor(p, 0, 250)
    const t = await deposit(p, 250, 'ATM CASH DEPOSIT')
    await confirmPicked(t)
    await reconcileDeposits(p.landlordId)
    const settled = await db.query(
      `SELECT COUNT(*)::int AS n FROM payments
        WHERE lease_id=$1 AND type='rent' AND status='settled'`, [p.lots[0].leaseId])
    expect(settled.rows[0].n).toBe(1)
  })
})

// S655 HIGH (decisions #11, money plan leftovers): a tenant's report used to
// settle their WHOLE open balance whatever the deposit — the matcher fell back
// to every open charge when no set added up. A report is picked only with
// charges that add up to it to the cent; anything else waits for the landlord
// with "covers $X of $Y owed".
describe('a report picks only what adds up to it, to the cent', () => {
  it('never picks a report that adds up to no set of the tenant’s charges', async () => {
    const p = await buildPark(1)
    const lot = p.lots[0]
    const old = (await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'carried_balance',500,'pending','2026-01-01','BALANCE') RETURNING id`,
      [lot.unitId, lot.leaseId, lot.tenantId, p.landlordId])).rows[0].id
    await declareFor(p, 0, 300)
    const txn = await deposit(p, 300, 'ATM CASH DEPOSIT')
    await reconcileDeposits(p.landlordId)
    expect(await picked(txn)).toBeUndefined()
    expect(await rentStatus(lot.rentId)).toBe('pending')
    expect(await rentStatus(old)).toBe('pending')
    expect((await db.query(`SELECT status FROM bank_transactions WHERE id=$1`, [txn])).rows[0].status).toBe('needs_review')
  })

  it('picks exactly the charges that add up to the report; the confirm leaves the rest open', async () => {
    const p = await buildPark(1)
    const lot = p.lots[0]
    const water = (await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'utility',40,'pending',CURRENT_DATE,'UTILITY') RETURNING id`,
      [lot.unitId, lot.leaseId, lot.tenantId, p.landlordId])).rows[0].id
    await declareFor(p, 0, 250)
    const t = await deposit(p, 250, 'ATM CASH DEPOSIT')
    await reconcileDeposits(p.landlordId)
    expect((await picked(t))?.chargeIds).toEqual([lot.rentId])
    await confirmPicked(t)
    expect(await rentStatus(lot.rentId)).toBe('settled')
    expect(await rentStatus(water)).toBe('pending')
  })
})

// ── S655 (money plan §3, Step 12): a tenant's whole bill to the cent ──────────
//
// Nic (10/2) had it settle by itself ("auto-settle a tenant's own bank deposit
// that equals exactly one tenant's whole open bill to the cent with nothing
// else fitting; same for a check memo naming the tenant with an exact amount").
// 10/14 (Nic, answer 16): "if gam 100 percent knows who that money came from it
// can file it but no guessing." An amount that happens to match, or a familiar
// name, is a guess: it is OFFERED on the deposit review, picked for the person
// to confirm (candidate preselect) — never settled by itself.

/** Every automatic step for the company; how many deposits were settled or tied by themselves. */
const settledByItself = async (landlordId: string) => {
  const r = await reconcileDeposits(landlordId)
  return r.slips + r.recorded + r.payouts
}

/** The deposit review's shortlist for one bank line. */
async function offered(t: string) {
  const row = (await db.query<any>(
    `SELECT id, landlord_id, amount::float AS amount, to_char(posted_date,'YYYY-MM-DD') AS posted_date, description
       FROM bank_transactions WHERE id = $1`, [t])).rows[0]
  return (await candidatesForDeposit(row)).candidates
}

const txnStatus = async (id: string) => (await db.query(
  `SELECT status, auto_settled_at IS NOT NULL AS auto FROM bank_transactions WHERE id=$1`, [id])).rows[0]

async function addLine(p: Park, i: number, type: string, amount: number, entry: string) {
  const lot = p.lots[i]
  return (await db.query(
    `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',CURRENT_DATE,$7) RETURNING id`,
    [lot.unitId, lot.leaseId, lot.tenantId, p.landlordId, type, amount.toFixed(2), entry])).rows[0].id
}


describe('Step 12 / 10/14: a deposit nobody reported is offered against a tenant’s whole bill, never settled by itself', () => {
  it('a tenant’s whole bank-payable bill to the cent is offered first, picked for the person to confirm', async () => {
    const p = await buildPark(1)
    const water = await addLine(p, 0, 'utility', 41.25, 'UTILITY')
    const home = await addLine(p, 0, 'home_payment', 200, 'HOMEPMT')
    const t = await deposit(p, 491.25, 'BRANCH DEPOSIT')
    expect(await settledByItself(p.landlordId)).toBe(0)
    for (const id of [p.lots[0].rentId, water, home]) expect(await rentStatus(id)).toBe('pending')
    expect(await txnStatus(t)).toEqual({ status: 'needs_review', auto: false })
    const top = (await offered(t))[0]
    expect(top).toMatchObject({ tenantId: p.lots[0].tenantId, confidence: 'amount_unique', preselect: true })
    expect([...top.chargeIds].sort()).toEqual([p.lots[0].rentId, water, home].sort())
    // The person confirms it.
    await confirmDepositMatch({ bankTransactionId: t, chargeIds: top.chargeIds, method: 'cash', confirmedByUserId: null })
    for (const id of [p.lots[0].rentId, water, home]) expect(await rentStatus(id)).toBe('settled')
  })

  it('a rival bill, a pending report or a same-amount deposit within 4 days stops it', async () => {
    // A rival: two tenants each owe exactly $250.
    const rival = await buildPark(2)
    const t1 = await deposit(rival, 250, 'BRANCH DEPOSIT')
    expect(await settledByItself(rival.landlordId)).toBe(0)
    expect((await txnStatus(t1)).status).toBe('needs_review')

    // Part of a bill is not the whole bill.
    const part = await buildPark(1)
    await addLine(part, 0, 'utility', 40, 'UTILITY')
    await deposit(part, 250, 'BRANCH DEPOSIT')
    expect(await settledByItself(part.landlordId)).toBe(0)
    expect(await rentStatus(part.lots[0].rentId)).toBe('pending')

    // A report from this household (of another amount) is the tenant's own story to check.
    const reported = await buildPark(1)
    await declareFor(reported, 0, 300)
    await deposit(reported, 250, 'BRANCH DEPOSIT')
    expect(await settledByItself(reported.landlordId)).toBe(0)
    expect(await rentStatus(reported.lots[0].rentId)).toBe('pending')

    // Someone else reported a deposit of this amount.
    const other = await buildPark(2)
    await db.query(`UPDATE payments SET amount = 999 WHERE id = $1`, [other.lots[1].rentId])
    await declareFor(other, 1, 250)
    await deposit(other, 250, 'BRANCH DEPOSIT')
    expect(await settledByItself(other.landlordId)).toBe(0)
    expect(await rentStatus(other.lots[0].rentId)).toBe('pending')

    // Two deposits of the same amount within 4 days: which is whose?
    const twice = await buildPark(1)
    await deposit(twice, 250, 'BRANCH DEPOSIT')
    await db.query(
      `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status)
       VALUES ($1,$2,$3,CURRENT_DATE - 3,250,'BRANCH DEPOSIT','categorized')`,
      [twice.connectionId, twice.landlordId, randomUUID()])
    expect(await settledByItself(twice.landlordId)).toBe(0)
    expect(await rentStatus(twice.lots[0].rentId)).toBe('pending')
  })

  it('a check memo naming the tenant with the exact amount is offered first (that tenant only), never settled by itself', async () => {
    const p = await buildPark(3)
    await db.query(`UPDATE users SET last_name = 'Garcia' WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`,
      [p.lots[1].tenantId])
    const t = await deposit(p, 250, 'REMOTE DEP CHK R GARCIA')
    expect(await settledByItself(p.landlordId)).toBe(0)
    for (const lot of p.lots) expect(await rentStatus(lot.rentId)).toBe('pending')
    expect((await txnStatus(t)).status).toBe('needs_review')
    const top = (await offered(t))[0]
    expect(top).toMatchObject({ tenantId: p.lots[1].tenantId, confidence: 'named_exact', preselect: true })
  })

  it('a deposit a person confirmed and then undid is never applied by itself', async () => {
    const p = await buildPark(1)
    const t = await deposit(p, 250, 'BRANCH DEPOSIT')
    await confirmDepositMatch({ bankTransactionId: t, chargeIds: [p.lots[0].rentId], method: 'cash', confirmedByUserId: null })
    await undoDepositMatch({ bankTransactionId: t, landlordId: p.landlordId, undoneBy: null })
    expect(await rentStatus(p.lots[0].rentId)).toBe('pending')
    expect((await txnStatus(t)).status).toBe('needs_review')
    expect(await settledByItself(p.landlordId)).toBe(0)
    expect(await rentStatus(p.lots[0].rentId)).toBe('pending')
  })

  it('a payout from a rent channel or another named payer never settles a bill on amount alone', async () => {
    const p = await buildPark(1)
    await deposit(p, 250, 'ST-B9S6S4F0D0I0 DOORLOOP CORPORATE ACH')
    await deposit(p, 250, 'Square Inc       SQ261001   261001 T3H80F2ZQ67M')
    // (Two deposits of $250 would stop it anyway; each is checked alone too.)
    await db.query(`UPDATE bank_transactions SET posted_date = CURRENT_DATE - 9 WHERE description LIKE 'Square%'`)
    expect(await settledByItself(p.landlordId)).toBe(0)
    expect(await rentStatus(p.lots[0].rentId)).toBe('pending')
  })

  // 10/5 (Nic): a bank deposit the office recorded from the bank's receipt is
  // never cash on hand, so nothing else competes for its bank line. Two months
  // behind with part payments on: the recorded $250 paid September, so the
  // household owes exactly $250 (October) — the bank's own line for that same
  // $250 must not "pay" October too.
  it('the bank line for a bank deposit the office already recorded never pays another bill by itself', async () => {
    const p = await buildPark(1)
    const lot = p.lots[0]
    await db.query(`UPDATE properties SET accept_partial_payments = TRUE WHERE id = $1`, [p.propertyId])
    const sep = (await db.query<{ id: string }>(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'rent',250,'pending',CURRENT_DATE - 30,'RENT') RETURNING id`,
      [lot.unitId, lot.leaseId, lot.tenantId, p.landlordId])).rows[0].id
    await db.query(`UPDATE payments SET created_at = now() - interval '31 days' WHERE id = $1`, [sep])
    const { settleManualRentPayment } = await import('./manualPaymentSettle')
    const client = await getClient()
    try {
      await client.query('BEGIN')
      const r = await settleManualRentPayment(client, {
        payment: { id: sep, landlord_id: p.landlordId, tenant_id: lot.tenantId, unit_id: lot.unitId,
          lease_id: lot.leaseId, due_date: null as any },
        method: 'bank_deposit', settledAt: null, reference: 'BR-1001', settleHousehold: true,
        amountTendered: 250, sendReceipt: false,
      } as any)
      await client.query('COMMIT')
      expect(r.stillOwed).toBe(250)
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
    expect(await rentStatus(sep)).toBe('settled')
    expect(await rentStatus(lot.rentId)).toBe('pending')

    const t = await deposit(p, 250, 'BRANCH DEPOSIT')
    expect(await settledByItself(p.landlordId)).toBe(0)
    expect((await txnStatus(t)).status).toBe('needs_review')
    // 10/6 review fix: the household's next month is still open for exactly
    // this amount, so the line could as well be a second deposit of theirs —
    // with no reference number on it GAM does not tie it by itself (and never
    // pays it onto that bill); a person picks.
    const r0 = await reconcileDeposits(p.landlordId)
    expect(r0).toMatchObject({ recorded: 0 })
    expect((await txnStatus(t)).status).toBe('needs_review')
    // 10/6 (Nic, "Yes, build it"): the receipt's reference number on the bank's
    // line says which deposit it is — tied to it (no money moves again), never
    // paid onto another bill.
    await db.query(`UPDATE bank_transactions SET description = 'BRANCH DEPOSIT BR-1001' WHERE id = $1`, [t])
    const r = await reconcileDeposits(p.landlordId)
    expect(r).toMatchObject({ recorded: 1 })
    expect(await rentStatus(lot.rentId)).toBe('pending')
    const tied = (await db.query<any>(`SELECT status, auto_settle_undo FROM bank_transactions WHERE id = $1`, [t])).rows[0]
    expect(tied.status).toBe('matched')
    expect(tied.auto_settle_undo).toMatchObject({ kind: 'recorded_deposit', auto: true, paymentIds: [sep] })
  })

  it('a bank line two recorded deposits could be waits for a person — nothing is tied or paid by itself', async () => {
    const p = await buildPark(2)
    for (const lot of p.lots) {
      const client = await getClient()
      try {
        await client.query('BEGIN')
        const { settleManualRentPayment } = await import('./manualPaymentSettle')
        await settleManualRentPayment(client, {
          payment: { id: lot.rentId, landlord_id: p.landlordId, tenant_id: lot.tenantId, unit_id: lot.unitId, lease_id: lot.leaseId, due_date: null as any },
          method: 'bank_deposit', settledAt: null, reference: `BR-${lot.unitId.slice(0, 4)}`, settleHousehold: true,
          amountTendered: 250, sendReceipt: false,
        } as any)
        await client.query('COMMIT')
      } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
    }
    const t = await deposit(p, 250, 'BRANCH DEPOSIT')
    expect(await reconcileDeposits(p.landlordId)).toMatchObject({ recorded: 0 })
    expect((await txnStatus(t)).status).toBe('needs_review')
    // The landlord sees both on the deposit review, to pick the one it is.
    const { candidatesForDeposit } = await import('./bankDepositCandidates')
    const row = (await db.query<any>(
      `SELECT id, landlord_id, amount::float AS amount, to_char(posted_date,'YYYY-MM-DD') AS posted_date, description FROM bank_transactions WHERE id = $1`, [t])).rows[0]
    expect((await candidatesForDeposit(row)).recordedDeposits).toHaveLength(2)
  })

  it('a deposit made before the bill existed never pays it by itself', async () => {
    const p = await buildPark(1)
    const t = await deposit(p, 250, 'BRANCH DEPOSIT')
    await db.query(`UPDATE bank_transactions SET posted_date = CURRENT_DATE - 12 WHERE id = $1`, [t])
    expect(await settledByItself(p.landlordId)).toBe(0)
    expect(await rentStatus(p.lots[0].rentId)).toBe('pending')
  })

  // S655 leftover (Steps 9 and 12): a settle that is neither Stripe nor credit
  // writes how it was paid, so an old failed card intent never reads as GAM-held.
  it('a move-in box row over an old failed intent, settled from a bank line, becomes landlord-funded paid-ahead money', async () => {
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
    const t = await deposit(p, 300, 'BRANCH DEPOSIT')
    expect(await settledByItself(p.landlordId)).toBe(0)
    await confirmDepositMatch({ bankTransactionId: t, chargeIds: [box], method: 'cash', confirmedByUserId: null })
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
    expect(await settledByItself(p.landlordId)).toBe(0)
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
    expect(await settledByItself(p.landlordId)).toBe(0)
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
    expect(await settledByItself(p.landlordId)).toBe(0)
    expect(await rentStatus(p.lots[0].rentId)).toBe('pending')
  })
})
