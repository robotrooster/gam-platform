/**
 * 10/6 (Nic) — same-amount bank deposits, told apart by the day and the hour.
 *
 * "GAM can match the transaction to something near that window because for
 * people that pay the exact same amount, the probability that they're going
 * to be in the bank at exactly the same time also kind of shrinks ... if both
 * payments are paid in full, then ... it doesn't matter if one person's cash
 * and the other person's cash get swapped when it's at the same time."
 *
 * Through the real paths: the bank feed's own steps (reconcileDeposits), the
 * landlord's match screen (unmatchedDepositsWithCandidates) and the
 * landlord's confirm (confirmDepositMatch).
 */
import { randomUUID } from 'crypto'
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stripeMocks = vi.hoisted(() => ({
  paymentIntentsCancel: vi.fn(async (id: string) => ({ id, status: 'canceled' })),
}))
vi.mock('../lib/stripe', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, getStripe: () => ({ paymentIntents: { cancel: stripeMocks.paymentIntentsCancel } }) }
})

import { db, getClient } from '../db'
import { reconcileDeposits, autoSettleDeclaredDeposits } from './bankFeed'
import { confirmDepositMatch, undoDepositMatch } from './bankDepositConfirm'
import { unmatchedDepositsWithCandidates } from './bankDepositCandidates'
import {
  cleanupAllSchema, seedLandlord, seedTenant, seedProperty, seedUnit, seedLease, seedLeaseTenant,
} from '../test/dbHelpers'

beforeEach(cleanupAllSchema)

interface Lot { tenantId: string; leaseId: string; unitId: string; rentId: string; name: string }
interface Park { landlordId: string; connId: string; lots: Lot[] }

/** Lots that all owe $450 rent due Oct 1, 2026 — the hard case. */
async function park(n: number): Promise<Park> {
  const client = await getClient()
  try {
    const { userId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await client.query(`UPDATE properties SET timezone = 'America/Phoenix' WHERE id = $1`, [propertyId])
    const connId = (await client.query(
      `INSERT INTO bank_connections (landlord_id, provider, status, last_synced_at)
       VALUES ($1,'stripe_fc','active',NOW()) RETURNING id`, [landlordId])).rows[0].id
    const names = ['Ana Bell', 'Cy Dorn', 'Eve Fox', 'Gus Hale']
    const lots: Lot[] = []
    for (let i = 0; i < n; i++) {
      const tenantId = await seedTenant(client)
      const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 450 })
      await client.query(`UPDATE units SET unit_number = $2 WHERE id = $1`, [unitId, `Lot ${i + 1}`])
      const leaseId = await seedLease(client, { unitId, landlordId, rentAmount: 450 })
      await seedLeaseTenant(client, { leaseId, tenantId, role: 'primary' })
      const [first, last] = names[i].split(' ')
      await client.query(
        `UPDATE users SET first_name = $2, last_name = $3 WHERE id = (SELECT user_id FROM tenants WHERE id = $1)`,
        [tenantId, first, last])
      const inv = (await client.query(
        `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount)
         VALUES ($1,$2,$3,$4,$5,'2026-10-01',450,450) RETURNING id`,
        [landlordId, tenantId, leaseId, unitId, `H-${randomUUID().slice(0, 8)}`])).rows[0]
      const rentId = (await client.query(
        `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,$5,'rent',450,'pending','2026-10-01','RENT') RETURNING id`,
        [inv.id, unitId, leaseId, tenantId, landlordId])).rows[0].id
      lots.push({ tenantId, leaseId, unitId, rentId, name: names[i] })
    }
    return { landlordId, connId, lots }
  } finally { client.release() }
}

/** A tenant's report, made at `madeAt` (the order ties are assigned in). */
async function reportFor(p: Park, i: number, o: {
  declared: string; hour?: number | null; afterHours?: boolean; madeAt: string; amount?: number
}): Promise<string> {
  const lot = p.lots[i]
  return (await db.query(
    `INSERT INTO tenant_declared_deposits
       (tenant_id, lease_id, landlord_id, amount, declared_date, method, reference,
        declared_hour, declared_after_hours, created_at)
     VALUES ($1,$2,$3,$4,$5::date,'cash',$6,$7,$8,$9::timestamptz) RETURNING id`,
    [lot.tenantId, lot.leaseId, p.landlordId, (o.amount ?? 450).toFixed(2), o.declared, `REF-${i}`,
     o.hour ?? null, o.afterHours === true, o.madeAt])).rows[0].id
}

async function bankLine(p: Park, posted: string, description: string, amount = 450): Promise<string> {
  return (await db.query(
    `INSERT INTO bank_transactions (bank_connection_id, landlord_id, external_id, posted_date, amount, description, status)
     VALUES ($1,$2,$3,$4::date,$5,$6,'needs_review') RETURNING id`,
    [p.connId, p.landlordId, randomUUID(), posted, amount.toFixed(2), description])).rows[0].id
}
const branch = (mmddyy: string, time: string) =>
  `eDeposit in Branch ${mmddyy} ${time} 360 W CONTINENTAL RD GREEN VALLEY AZ`

const reportRow = async (id: string) => (await db.query(
  `SELECT status, bank_transaction_id, false_date_flagged_at FROM tenant_declared_deposits WHERE id = $1`, [id])).rows[0]
const rentRow = async (id: string) => (await db.query(
  `SELECT status, to_char(settled_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS settled_on FROM payments WHERE id = $1`, [id])).rows[0]

describe('the bank feed pairs reports with lines by itself', () => {
  it('a single report matches its deposit', async () => {
    const p = await park(1)
    const r = await reportFor(p, 0, { declared: '2026-10-01', hour: 15, madeAt: '2026-10-01T23:00:00Z' })
    const l = await bankLine(p, '2026-10-01', 'DEPOSIT *4662')
    expect(await autoSettleDeclaredDeposits(p.landlordId)).toBe(1)
    expect(await reportRow(r)).toMatchObject({ status: 'confirmed', bank_transaction_id: l, false_date_flagged_at: null })
    expect(await rentRow(p.lots[0].rentId)).toEqual({ status: 'settled', settled_on: '2026-10-01' })
  })

  it('two same-amount reports the same day and two deposits: matched in report order, both on time', async () => {
    const p = await park(2)
    // Lot 2 reported first. Neither line carries a time.
    const second = await reportFor(p, 0, { declared: '2026-10-01', hour: 15, madeAt: '2026-10-01T23:30:00Z' })
    const first = await reportFor(p, 1, { declared: '2026-10-01', hour: 15, madeAt: '2026-10-01T23:00:00Z' })
    const lA = await bankLine(p, '2026-10-01', 'DEPOSIT *4662')
    const lB = await bankLine(p, '2026-10-01', 'DEPOSIT *4662')
    const earliestLine = [lA, lB].sort()[0]
    const r = await reconcileDeposits(p.landlordId)
    expect(r.declared).toBe(2)
    expect((await reportRow(first)).bank_transaction_id).toBe(earliestLine)
    expect((await reportRow(second)).bank_transaction_id).toBe([lA, lB].sort()[1])
    // Swapped or not, the outcome is the same: both paid on Oct 1, nothing flagged.
    for (const lot of p.lots) expect(await rentRow(lot.rentId)).toEqual({ status: 'settled', settled_on: '2026-10-01' })
    for (const id of [first, second]) expect((await reportRow(id)).false_date_flagged_at).toBeNull()
  })

  it('lines with a time go to the nearest hour each tenant gave, whatever order they reported in', async () => {
    const p = await park(2)
    // The 4 PM depositor reported first, the 9 AM one second.
    const four = await reportFor(p, 0, { declared: '2026-09-30', hour: 16, madeAt: '2026-10-01T15:00:00Z' })
    const nine = await reportFor(p, 1, { declared: '2026-09-30', hour: 9, madeAt: '2026-10-01T16:00:00Z' })
    // Mountain View's bank: the deposit's own date and time, posted the next day.
    const morning = await bankLine(p, '2026-10-01', branch('09/30/26', '09:12:40 AM'))
    const afternoon = await bankLine(p, '2026-10-01', branch('09/30/26', '04:39:28 PM'))
    expect((await reconcileDeposits(p.landlordId)).declared).toBe(2)
    expect((await reportRow(four)).bank_transaction_id).toBe(afternoon)
    expect((await reportRow(nine)).bank_transaction_id).toBe(morning)
    for (const lot of p.lots) expect(await rentRow(lot.rentId)).toEqual({ status: 'settled', settled_on: '2026-09-30' })
  })

  it('lines with no time: each report goes to the deposit of its own day', async () => {
    const p = await park(2)
    const thu = await reportFor(p, 0, { declared: '2026-10-01', hour: 10, madeAt: '2026-10-02T15:00:00Z' })
    const fri = await reportFor(p, 1, { declared: '2026-10-02', hour: 10, madeAt: '2026-10-02T14:00:00Z' })
    const lThu = await bankLine(p, '2026-10-01', 'DEPOSIT *4662')
    const lFri = await bankLine(p, '2026-10-02', 'DEPOSIT *4662')
    expect((await reconcileDeposits(p.landlordId)).declared).toBe(2)
    expect((await reportRow(thu)).bank_transaction_id).toBe(lThu)
    expect((await reportRow(fri)).bank_transaction_id).toBe(lFri)
  })

  it('the false-date rule still works: posted later than the next business day, the bank’s date decides and the report is flagged', async () => {
    const p = await park(1)
    const r = await reportFor(p, 0, { declared: '2026-10-01', hour: 15, madeAt: '2026-10-01T23:00:00Z' })
    const l = await bankLine(p, '2026-10-06', 'DEPOSIT *4662')
    expect(await autoSettleDeclaredDeposits(p.landlordId)).toBe(1)
    const row = await reportRow(r)
    expect(row.bank_transaction_id).toBe(l)
    expect(row.false_date_flagged_at).not.toBeNull()
    expect(await rentRow(p.lots[0].rentId)).toEqual({ status: 'settled', settled_on: '2026-10-06' })
  })
})

describe('a real conflict waits for the landlord', () => {
  it('same amount on different days, where who gets which decides who paid late', async () => {
    const p = await park(2)
    const a = await reportFor(p, 0, { declared: '2026-10-01', madeAt: '2026-10-01T23:00:00Z' })
    const b = await reportFor(p, 1, { declared: '2026-10-01', madeAt: '2026-10-01T23:10:00Z' })
    const onTime = await bankLine(p, '2026-10-01', 'DEPOSIT *4662')
    const late = await bankLine(p, '2026-10-07', 'DEPOSIT *4662')
    const r = await reconcileDeposits(p.landlordId)
    expect(r.declared + r.autoSettled).toBe(0)
    for (const id of [a, b]) expect((await reportRow(id)).status).toBe('pending')

    const { deposits } = await unmatchedDepositsWithCandidates(p.landlordId)
    const card = deposits.find(d => d.transactionId === onTime)!
    expect(card.reportConflict?.kind).toBe('who_is_late')
    expect(card.reportConflict?.text).toContain('Two residents reported $450.00 on Oct 1 — pick which deposit is whose.')
    expect(card.reportConflict?.reports.map(x => x.tenantName).sort()).toEqual(['Ana Bell', 'Cy Dorn'])
    expect(card.reportConflict?.reports.every(x => !!x.reference)).toBe(true)
    // Each report is a choice — none picked for the landlord.
    expect(card.candidates.filter(c => c.declaration).map(c => c.declaration!.id).sort()).toEqual([a, b].sort())
    expect(card.candidates.every(c => !c.preselect)).toBe(true)
    expect(deposits.find(d => d.transactionId === late)!.reportConflict?.kind).toBe('who_is_late')

    // The landlord picks: the on-time deposit is Cy's.
    const cy = card.candidates.find(c => c.declaration?.id === b)!
    const done = await confirmDepositMatch({
      bankTransactionId: onTime, chargeIds: cy.chargeIds, method: 'cash', declarationId: b, confirmedByUserId: null,
    })
    expect(done.declarationId).toBe(b)
    expect(await rentRow(p.lots[1].rentId)).toEqual({ status: 'settled', settled_on: '2026-10-01' })
    // What is left is certain: Ana's report and the later deposit (the bank's date decides).
    expect((await reconcileDeposits(p.landlordId)).declared).toBe(1)
    expect(await reportRow(a)).toMatchObject({ status: 'confirmed', bank_transaction_id: late })
    expect((await reportRow(a)).false_date_flagged_at).not.toBeNull()
  })

  it('two reports claiming one deposit, nothing to tell them apart', async () => {
    const p = await park(2)
    await reportFor(p, 0, { declared: '2026-10-01', hour: 15, madeAt: '2026-10-01T23:00:00Z' })
    await reportFor(p, 1, { declared: '2026-10-01', hour: 15, madeAt: '2026-10-01T23:10:00Z' })
    const l = await bankLine(p, '2026-10-01', 'DEPOSIT *4662')
    expect((await reconcileDeposits(p.landlordId)).declared).toBe(0)
    const { deposits } = await unmatchedDepositsWithCandidates(p.landlordId)
    expect(deposits.find(d => d.transactionId === l)!.reportConflict?.kind).toBe('fewer_deposits')
  })

  it('one deposit equal to what two residents reported together', async () => {
    const p = await park(3)
    await reportFor(p, 0, { declared: '2026-10-01', hour: 11, madeAt: '2026-10-01T23:00:00Z' })
    await reportFor(p, 1, { declared: '2026-10-01', hour: 11, madeAt: '2026-10-01T23:10:00Z' })
    // Lot 3 owes exactly $900 too, so the deposit would otherwise be its whole bill to the cent.
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
       VALUES ($1,$2,$3,$4,'utility',450,'pending','2026-10-01','UTILITY')`,
      [p.lots[2].unitId, p.lots[2].leaseId, p.lots[2].tenantId, p.landlordId])
    const l = await bankLine(p, '2026-10-01', 'DEPOSIT *4662', 900)
    const r = await reconcileDeposits(p.landlordId)
    expect(r.declared + r.autoSettled + r.slips + r.inferred).toBe(0)
    expect((await db.query(`SELECT status FROM bank_transactions WHERE id = $1`, [l])).rows[0].status).toBe('needs_review')
    const { deposits } = await unmatchedDepositsWithCandidates(p.landlordId)
    const card = deposits.find(d => d.transactionId === l)!
    expect(card.reportConflict?.kind).toBe('combined')
    expect(card.reportConflict?.text).toBe('This $900.00 deposit equals what two residents reported together '
      + '($450.00 each, on Oct 1). GAM can\'t split one deposit between residents — record each resident\'s part from the payments screen.')
    expect(card.reportConflict?.reports.map(x => x.hour)).toEqual([11, 11])
  })
})

describe('the landlord’s confirm that names no report', () => {
  it('ties the report the matcher pairs with that line — never one paired with another line', async () => {
    const p = await park(2)
    // Both reported $450 on Oct 1 at different hours; Lot 1's deposit says 9 AM, Lot 2's 3 PM.
    const r9 = await reportFor(p, 0, { declared: '2026-10-01', hour: 9, madeAt: '2026-10-01T23:00:00Z' })
    const r15 = await reportFor(p, 1, { declared: '2026-10-01', hour: 15, madeAt: '2026-10-01T23:10:00Z' })
    const l9 = await bankLine(p, '2026-10-01', branch('10/01/26', '09:05:00 AM'))
    const l15 = await bankLine(p, '2026-10-01', branch('10/01/26', '03:02:00 PM'))
    // The landlord records the 3 PM line against Lot 2 from the screen, by charges alone.
    const done = await confirmDepositMatch({
      bankTransactionId: l15, chargeIds: [p.lots[1].rentId], method: 'cash', confirmedByUserId: null,
    })
    expect(done.declarationId).toBe(r15)
    expect((await reportRow(r9)).status).toBe('pending')
    expect((await reconcileDeposits(p.landlordId)).declared).toBe(1)
    expect((await reportRow(r9)).bank_transaction_id).toBe(l9)
  })

  it('10/6 review: the line the report was NOT paired with, recorded against that household, still takes their report', async () => {
    const p = await park(1)
    // One report; two $450 lines the same day with no times. The matcher pairs
    // the report with whichever sorts first; the landlord records the other.
    const r = await reportFor(p, 0, { declared: '2026-10-01', hour: 15, madeAt: '2026-10-01T23:00:00Z' })
    const lA = await bankLine(p, '2026-10-01', 'DEPOSIT *4662')
    const lB = await bankLine(p, '2026-10-01', 'DEPOSIT *4662')
    const notPaired = [lA, lB].sort()[1]
    const done = await confirmDepositMatch({
      bankTransactionId: notPaired, chargeIds: [p.lots[0].rentId], method: 'cash', confirmedByUserId: null,
    })
    expect(done.declarationId).toBe(r)
    expect(await reportRow(r)).toMatchObject({ status: 'confirmed', bank_transaction_id: notPaired, false_date_flagged_at: null })
    expect(await rentRow(p.lots[0].rentId)).toEqual({ status: 'settled', settled_on: '2026-10-01' })
  })
})

describe('Undo means "not this line" for the matcher too', () => {
  it('after Undo, the report pairs with its real deposit instead of the line it was un-tied from', async () => {
    const p = await park(1)
    const r = await reportFor(p, 0, { declared: '2026-10-01', hour: 15, madeAt: '2026-10-01T23:00:00Z' })
    const wrong = await bankLine(p, '2026-10-01', 'DEPOSIT *4662')
    expect(await autoSettleDeclaredDeposits(p.landlordId)).toBe(1)
    expect((await reportRow(r)).bank_transaction_id).toBe(wrong)
    await undoDepositMatch({ bankTransactionId: wrong, landlordId: p.landlordId, undoneBy: null })
    expect((await reportRow(r)).status).toBe('pending')

    // The real deposit posts the next business day.
    const real = await bankLine(p, '2026-10-02', 'DEPOSIT *4662')
    const { deposits } = await unmatchedDepositsWithCandidates(p.landlordId)
    expect(deposits.find(d => d.transactionId === wrong)!.candidates.some(c => c.declaration?.id === r)).toBe(false)
    expect(deposits.find(d => d.transactionId === real)!.candidates.some(c => c.declaration?.id === r)).toBe(true)
    expect((await reconcileDeposits(p.landlordId)).declared).toBe(1)
    expect(await reportRow(r)).toMatchObject({ status: 'confirmed', bank_transaction_id: real, false_date_flagged_at: null })
    expect(await rentRow(p.lots[0].rentId)).toEqual({ status: 'settled', settled_on: '2026-10-01' })
  })
})
