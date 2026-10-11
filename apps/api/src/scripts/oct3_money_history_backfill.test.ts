/**
 * S655 money plan P2 — the money history backfill, on a production-shaped
 * fixture: the same ids, amounts and timestamps as production for every case
 * the backfill knows by name (Kim Harland, Russ Fuller), and the same shapes
 * for the rest (Todd Niemeier's two-month check, Glenda Greek's posted check,
 * RV 52, RV 33, MH 25), plus a prior arrangement and a $0 desk action.
 *
 * Production counts have moved since the plan was written (78 rows / 41
 * actions on 10/2; 102 rows / 52 actions on 10/3), so the count asserted here
 * is this fixture's: every desk action with money gets exactly one receipt.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { PoolClient } from 'pg'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  runMoneyHistoryBackfill, BackfillRefused, PRODUCTION_HISTORY, unfilteredPaidAheadReads, unfilteredPaidAheadReaders,
} from './oct3_money_history_backfill'
import { checkMoneyInvariants } from './oct3_money_invariants_check'

const KIM = {
  tenantCredit: 'e063a957-d1c4-43da-b57d-a379ca75c9b3',
  rent: '76262ebb-9cd5-4a8b-ba33-cc10d1c5ca46',
  roundUp: '4cd989a7-60e2-4090-9cef-ceb3908a88de',
  at: '2026-09-09 11:27:54.174213-07',
}
const RUSS = {
  tenantCredit: '5dded090-e217-48f5-b795-632f82f45430',
  lease: 'f5d6de02-863c-488f-b0df-53b52b6f5c26',
  water: '9d85d800-d82b-4a54-ab84-7a0d5b6fea1a',
  trash: 'bfa97588-4142-4eb9-b7c2-4904835aebcd',
  rent: 'abeb37a9-f8f6-4448-9bba-d027322ba85f',
  billRun: '2026-10-01 07:00:01.126724-07',
  desk: '2026-10-01 17:03:42.064346-07',
}

interface Fx {
  oakPark: string; mountainView: string
  ids: Record<string, string>
}

async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query('COMMIT')
    return r
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

/** A tenant on a unit with an active lease (optionally with a known lease id). */
async function resident(c: PoolClient, landlordId: string, propertyId: string, unit: string, leaseId?: string) {
  const unitId = await seedUnit(c, { propertyId, landlordId })
  await c.query(`UPDATE units SET unit_number = $2 WHERE id = $1`, [unitId, unit])
  const tenantId = await seedTenant(c)
  const lease = await c.query<{ id: string }>(
    `INSERT INTO leases (id, unit_id, landlord_id, rent_amount, lease_type, status, start_date)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, 460, 'month_to_month', 'active', '2026-08-01') RETURNING id`,
    [leaseId ?? null, unitId, landlordId])
  await c.query(`INSERT INTO lease_tenants (lease_id, tenant_id, role) VALUES ($1, $2, 'primary')`, [lease.rows[0].id, tenantId])
  return { unitId, tenantId, leaseId: lease.rows[0].id }
}

async function row(c: PoolClient, r: { unitId: string; tenantId: string; leaseId: string }, landlordId: string, o: {
  id?: string; type?: string; entry?: string; amount: number; due: string; status?: string; settledAt?: string | null
  method?: string | null; notes?: string | null; created?: string
}): Promise<string> {
  const res = await c.query<{ id: string }>(
    `INSERT INTO payments (id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description,
                           settled_at, manual_method, notes, created_at)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12, $13,
             COALESCE($14::timestamptz, now()))
     RETURNING id`,
    [o.id ?? null, r.unitId, r.leaseId, r.tenantId, landlordId, o.type ?? 'rent', o.amount, o.status ?? 'settled', o.due,
     o.entry ?? ((o.type ?? 'rent') === 'rent' ? 'RENT' : 'UTILITY'), o.settledAt ?? null, o.method ?? null, o.notes ?? null, o.created ?? null])
  return res.rows[0].id
}

async function prepaid(c: PoolClient, r: { tenantId: string; leaseId: string }, o: {
  id?: string; amount: number; remaining: number; created: string; note?: string | null; sourceRemittanceId?: string | null
}): Promise<string> {
  const res = await c.query<{ id: string }>(
    `INSERT INTO lease_prepaid_credits (id, lease_id, tenant_id, amount_original, amount_remaining, created_at, updated_at, note, source_remittance_id)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6::timestamptz, $6::timestamptz, $7, $8) RETURNING id`,
    [o.id ?? null, r.leaseId, r.tenantId, o.amount, o.remaining, o.created, o.note ?? null, o.sourceRemittanceId ?? null])
  return res.rows[0].id
}

async function draw(c: PoolClient, r: { leaseId: string }, creditId: string, amount: number, at: string) {
  await c.query(
    `INSERT INTO lease_prepaid_credit_draws (lease_id, credit_id, payment_id, amount, billing_month, created_at)
     VALUES ($1, $2, NULL, $3, '2026-10-01', $4::timestamptz)`, [r.leaseId, creditId, amount, at])
}

/**
 * The seeded rows are production history from before C0: credits that are
 * already part-spent (Kim's $450 Move In Special at $0 left, Todd's $460 at $0)
 * were written by the old code, which moved amount_remaining directly. Once C0
 * is applied that is refused ("A new credit starts whole"), so the seed turns
 * on the same bypass the real backfill uses (oct3_money_history_backfill.ts
 * sets gam.credit_backfill for its own run) and turns it off before handing
 * the transaction back.
 */
async function asHistory(c: PoolClient, fn: () => Promise<void>): Promise<void> {
  await c.query(`SET LOCAL gam.credit_backfill = 'on'`)
  try { await fn() } finally { await c.query(`SET LOCAL gam.credit_backfill = 'off'`) }
}

async function fixture(): Promise<Fx> {
  return tx(async c => {
    await c.query(`SET LOCAL gam.credit_backfill = 'on'`)
    const op = await seedLandlord(c)
    const mv = await seedLandlord(c)
    const opProp = await seedProperty(c, { landlordId: op.landlordId, ownerUserId: op.userId, managedByUserId: op.userId })
    const mvProp = await seedProperty(c, { landlordId: mv.landlordId, ownerUserId: mv.userId, managedByUserId: mv.userId })
    const ids: Record<string, string> = {}

    // ── Kim Harland, APT 04 (Oak Park): $935.45 of rows, $450 Move In Special,
    //    money order typed $486.00 against $485.45; Nic voided the $0.55.
    const kim = await resident(c, op.landlordId, opProp, 'APT 04')
    await c.query(
      `INSERT INTO tenant_credits (id, landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason, created_at)
       VALUES ($1, $2, $3, $4, 450, 0, 'other', 'Move In Special', '2026-09-05 17:17:52-07')`,
      [KIM.tenantCredit, op.landlordId, kim.tenantId, kim.leaseId])
    const kimNote = 'Recorded as manual money_order payment (ref 55109266912)'
    const created = '2026-09-04 13:12:54.136725-07'
    ids.kimWater = await row(c, kim, op.landlordId, { type: 'utility', amount: 10.45, due: '2026-09-01', settledAt: KIM.at, method: 'money_order', notes: `Water — Aug 2026 — ${kimNote}`, created })
    ids.kimTrash = await row(c, kim, op.landlordId, { type: 'utility', amount: 25, due: '2026-09-01', settledAt: KIM.at, method: 'money_order', notes: `Trash — Sep 2026 — ${kimNote}`, created })
    await row(c, kim, op.landlordId, { id: KIM.rent, amount: 900, due: '2026-09-01', settledAt: KIM.at, method: 'money_order', notes: kimNote, created })
    await prepaid(c, kim, { id: KIM.roundUp, amount: 0.55, remaining: 0, created: KIM.at, note: 'Voided 10/3 (Nic): money order 55109266912 was entered as $486.00 against $485.45 owed; nothing was paid ahead' })

    // ── Russ Fuller, RV 02 (Oak Park): $37.60 entered as a credit on Aug 12.
    const russ = await resident(c, op.landlordId, opProp, 'RV 02', RUSS.lease)
    await c.query(
      `INSERT INTO tenant_credits (id, landlord_id, tenant_id, lease_id, amount_original, amount_remaining, category, reason, created_at)
       VALUES ($1, $2, $3, $4, 37.60, 0, 'other', 'Carried-forward overpayment — paid cash ahead', '2026-08-12 12:00:00-07')`,
      [RUSS.tenantCredit, op.landlordId, russ.tenantId, RUSS.lease])
    await row(c, russ, op.landlordId, { id: RUSS.water, type: 'utility', amount: 5.22, due: '2026-10-01', settledAt: RUSS.billRun, notes: 'covered by account credit', created: RUSS.billRun })
    await row(c, russ, op.landlordId, { id: RUSS.trash, type: 'utility', amount: 25, due: '2026-10-01', settledAt: RUSS.billRun, notes: 'covered by account credit', created: RUSS.billRun })
    await row(c, russ, op.landlordId, { id: RUSS.rent, amount: 440, due: '2026-10-01', settledAt: RUSS.desk, method: 'cash', notes: 'Recorded as manual cash payment', created: RUSS.billRun })
    ids.russElectric = await row(c, russ, op.landlordId, { type: 'utility', amount: 73.50, due: '2026-10-01', settledAt: RUSS.desk, method: 'cash', notes: 'Electric — Recorded as manual cash payment', created: RUSS.billRun })
    ids.russRoundUp = await prepaid(c, russ, { amount: 0.88, remaining: 0.88, created: RUSS.desk })

    // ── RV 33 (Oak Park): $600 cash for $589.71, $10.29 banked; $5.22 drawn Oct 1.
    const rv33 = await resident(c, op.landlordId, opProp, 'RV 33')
    const rv33At = '2026-09-09 11:01:46.182335-07'
    await row(c, rv33, op.landlordId, { amount: 550, due: '2026-09-01', settledAt: rv33At, method: 'cash' })
    await row(c, rv33, op.landlordId, { type: 'utility', amount: 20, due: '2026-09-01', settledAt: rv33At, method: 'cash' })
    await row(c, rv33, op.landlordId, { type: 'utility', amount: 14.71, due: '2026-09-01', settledAt: rv33At, method: 'cash' })
    await row(c, rv33, op.landlordId, { type: 'utility', amount: 5, due: '2026-09-01', settledAt: rv33At, method: 'cash' })
    ids.rv33Credit = await prepaid(c, rv33, { amount: 10.29, remaining: 5.07, created: rv33At })
    const rv33Draw = '2026-10-01 07:00:01.084904-07'
    ids.rv33Oct = await row(c, rv33, op.landlordId, { type: 'utility', amount: 5.22, due: '2026-10-01', settledAt: rv33Draw, notes: 'covered by prepaid credit (paid ahead) (collected by the landlord, not GAM)', created: rv33Draw })
    await draw(c, rv33, ids.rv33Credit, 5.22, rv33Draw)

    // ── Todd Niemeier, MH 08 (Mountain View): one $920 check for September and October.
    const todd = await resident(c, mv.landlordId, mvProp, 'MH 08')
    const toddAt = '2026-09-18 13:04:41.181103-07'
    await row(c, todd, mv.landlordId, { amount: 460, due: '2026-09-01', settledAt: toddAt, method: 'check', notes: 'Recorded as manual check payment (ref 1001)' })
    ids.toddCredit = await prepaid(c, todd, { amount: 460, remaining: 0, created: toddAt })
    const toddDraw = '2026-10-01 07:00:00.870855-07'
    ids.toddOct = await row(c, todd, mv.landlordId, { amount: 460, due: '2026-10-01', settledAt: toddDraw, notes: 'covered by prepaid credit (paid ahead) (collected by the landlord, not GAM)', created: toddDraw })
    await draw(c, todd, ids.toddCredit, 460, toddDraw)

    // ── Glenda Greek, MH 04 (Mountain View): a posted $460 check, received 9/22.
    const glenda = await resident(c, mv.landlordId, mvProp, 'MH 04')
    const glendaRem = await c.query<{ id: string }>(
      `INSERT INTO tenant_remittances (tenant_id, lease_id, landlord_id, amount, applied_amount, unapplied_amount, status,
                                       payment_method, gross_amount, processing_fee_amount, settled_at, reference, notes)
       VALUES ($1, $2, $3, 460, 0, 460, 'settled', 'check', 460, 0, '2026-09-22 12:00:00-07', '1264', 'Paid by Jason Holcomb')
       RETURNING id`, [glenda.tenantId, glenda.leaseId, mv.landlordId])
    ids.glendaRem = glendaRem.rows[0].id
    ids.glendaCredit = await prepaid(c, glenda, { amount: 460, remaining: 0, created: '2026-09-22 13:50:13.774043-07', sourceRemittanceId: ids.glendaRem })
    const glendaDraw = '2026-10-01 07:00:00.775154-07'
    ids.glendaOct = await row(c, glenda, mv.landlordId, { amount: 460, due: '2026-10-01', settledAt: glendaDraw, notes: 'covered by prepaid credit (paid ahead) (collected by the landlord, not GAM)', created: glendaDraw })
    await draw(c, glenda, ids.glendaCredit, 460, glendaDraw)

    // ── RV 52 (Mountain View): a $600 check for $302.94, $297.06 banked; $14.70 drawn Oct 1.
    const rv52 = await resident(c, mv.landlordId, mvProp, 'RV 52')
    const rv52At = '2026-09-22 11:01:03.860808-07'
    await row(c, rv52, mv.landlordId, { amount: 250, due: '2026-09-22', settledAt: rv52At, method: 'check', notes: 'Recorded as manual check payment (ref 2210)' })
    await row(c, rv52, mv.landlordId, { type: 'utility', amount: 52.94, due: '2026-09-22', settledAt: rv52At, method: 'check', notes: 'Recorded as manual check payment (ref 2210)' })
    ids.rv52Credit = await prepaid(c, rv52, { amount: 297.06, remaining: 282.36, created: rv52At })
    const rv52Draw = '2026-10-01 07:00:00.713107-07'
    ids.rv52Oct = await row(c, rv52, mv.landlordId, { type: 'utility', amount: 14.70, due: '2026-10-01', settledAt: rv52Draw, notes: 'Electric — covered by prepaid credit (paid ahead) (collected by the landlord, not GAM)', created: rv52Draw })
    await draw(c, rv52, ids.rv52Credit, 14.70, rv52Draw)

    // ── MH 25 (Mountain View): a $470 check for $460; the $10 stays as it is.
    const mh25 = await resident(c, mv.landlordId, mvProp, 'MH 25')
    const mh25At = '2026-09-09 10:28:53.388458-07'
    await row(c, mh25, mv.landlordId, { amount: 460, due: '2026-09-01', settledAt: mh25At, method: 'check' })
    ids.mh25Credit = await prepaid(c, mh25, { amount: 10, remaining: 10, created: mh25At })

    // ── A prior arrangement (no receipt) and a $0 desk action (no receipt).
    const rv09 = await resident(c, mv.landlordId, mvProp, 'RV 09')
    await row(c, rv09, mv.landlordId, { amount: 300, due: '2026-08-01', settledAt: '2026-09-01 10:00:00-07', method: 'prior_arrangement' })
    await row(c, rv09, mv.landlordId, { amount: 0, due: '2026-10-01', settledAt: '2026-10-03 08:32:01.054452-07', method: 'cash' })

    await c.query(`SET LOCAL gam.credit_backfill = 'off'`)
    return { oakPark: op.landlordId, mountainView: mv.landlordId, ids }
  })
}

async function runBackfill() {
  return tx(c => runMoneyHistoryBackfill(c, PRODUCTION_HISTORY))
}

const receiptOf = async (paymentId: string) => (await db.query<any>(
  `SELECT r.id, r.amount::text, r.applied_amount::text, r.unapplied_amount::text, r.payment_method, r.gross_amount, r.reference, r.status
     FROM tenant_remittances r JOIN remittance_applications a ON a.remittance_id = r.id
    WHERE a.payment_id = $1`, [paymentId])).rows

beforeEach(async () => { await cleanupAllSchema() })

describe('the money history backfill (P2)', () => {
  it('reproduces Kim, Russ, Todd, Glenda, RV 52 and RV 33 exactly', async () => {
    const f = await fixture()
    const r = await runBackfill()

    // Kim: $485.45 money order, $450 Move In Special on rent, the $0.55 withdrawn.
    const kim = await receiptOf(KIM.rent)
    expect(kim).toMatchObject([{ amount: '485.45', applied_amount: '485.45', unapplied_amount: '0.00', payment_method: 'money_order', gross_amount: null, reference: '55109266912' }])
    const kimRent = (await db.query<any>(`SELECT issued_credit_amount::text AS i FROM payments WHERE id = $1`, [KIM.rent])).rows[0]
    expect(kimRent.i).toBe('450.00')
    const kimUse = (await db.query<any>(`SELECT amount::text, status, source, remittance_id, to_char(billing_month,'YYYY-MM-DD') AS m, applied_at FROM credit_uses WHERE tenant_credit_id = $1`, [KIM.tenantCredit])).rows
    expect(kimUse).toMatchObject([{ amount: '450.00', status: 'applied', source: 'backfill', remittance_id: kim[0].id, m: '2026-09-01' }])
    expect(new Date(kimUse[0].applied_at).toISOString()).toBe('2026-09-09T18:27:54.174Z')
    const kimRoundUp = (await db.query<any>(`SELECT amount_remaining::text AS r, voided_at IS NOT NULL AS voided, void_reason, source_remittance_id FROM lease_prepaid_credits WHERE id = $1`, [KIM.roundUp])).rows[0]
    expect(kimRoundUp).toMatchObject({ r: '0.55', voided: true, source_remittance_id: null })
    expect(kimRoundUp.void_reason).toMatch(/\$485\.45/)

    // Russ: re-recorded as cash paid ahead on Aug 12; three spends move onto it.
    const russCredit = (await db.query<any>(
      `SELECT id, amount_original::text AS o, amount_remaining::text AS r, funded_by, received_at FROM lease_prepaid_credits WHERE lease_id = $1 AND note LIKE 'Paid ahead before GAM%'`, [RUSS.lease])).rows
    expect(russCredit).toHaveLength(1)
    expect(russCredit[0]).toMatchObject({ o: '37.60', r: '0.00', funded_by: 'landlord' })
    expect(new Date(russCredit[0].received_at).toISOString()).toBe('2026-08-12T19:00:00.000Z')
    const russUses = (await db.query<any>(`SELECT payment_id, amount::text, remittance_id FROM credit_uses WHERE prepaid_credit_id = $1 ORDER BY credit_uses.amount`, [russCredit[0].id])).rows
    const russDesk = await receiptOf(RUSS.rent)
    expect(russUses).toEqual([
      { payment_id: RUSS.water, amount: '5.22', remittance_id: null },
      { payment_id: RUSS.rent, amount: '7.38', remittance_id: russDesk[0].id },
      { payment_id: RUSS.trash, amount: '25.00', remittance_id: null },
    ])
    // $440 rent − $7.38 + $73.50 electric = $506.12 handed over for rows, + $0.88 banked = $507.00.
    expect(russDesk[0]).toMatchObject({ amount: '507.00', applied_amount: '506.12', unapplied_amount: '0.88', payment_method: 'cash' })
    const russRoundUp = (await db.query<any>(`SELECT source_remittance_id, funded_by FROM lease_prepaid_credits WHERE id = $1`, [f.ids.russRoundUp])).rows[0]
    expect(russRoundUp).toEqual({ source_remittance_id: russDesk[0].id, funded_by: 'landlord' })
    const russTc = (await db.query<any>(`SELECT amount_remaining::text AS r, status, reason FROM tenant_credits WHERE id = $1`, [RUSS.tenantCredit])).rows[0]
    expect(russTc).toMatchObject({ r: '37.60', status: 'void' })
    expect(russTc.reason).toMatch(/re-recorded as cash paid ahead \(received Aug 12\)/)
    const notes = (await db.query<any>(`SELECT notes FROM payments WHERE id = ANY($1::uuid[])`, [[RUSS.water, RUSS.trash]])).rows
    expect(notes.every((n: any) => /paid from money paid ahead \(Aug 12\)/.test(n.notes))).toBe(true)

    // Todd: a $920 check, $460 for September and $460 paid ahead, spent on October.
    const todd = (await db.query<any>(`SELECT r.amount::text, r.unapplied_amount::text AS u FROM tenant_remittances r JOIN lease_prepaid_credits c ON c.source_remittance_id = r.id WHERE c.id = $1`, [f.ids.toddCredit])).rows
    expect(todd).toEqual([{ amount: '920.00', u: '460.00' }])
    const toddUse = (await db.query<any>(`SELECT payment_id, amount::text FROM credit_uses WHERE prepaid_credit_id = $1`, [f.ids.toddCredit])).rows
    expect(toddUse).toEqual([{ payment_id: f.ids.toddOct, amount: '460.00' }])

    // Glenda: her posted check stays her receipt; its gross is cleared; October paid from it.
    const glenda = (await db.query<any>(`SELECT amount::text, gross_amount FROM tenant_remittances WHERE id = $1`, [f.ids.glendaRem])).rows[0]
    expect(glenda).toEqual({ amount: '460.00', gross_amount: null })
    const glendaCredit = (await db.query<any>(`SELECT funded_by, received_at FROM lease_prepaid_credits WHERE id = $1`, [f.ids.glendaCredit])).rows[0]
    expect(glendaCredit.funded_by).toBe('landlord')
    expect(new Date(glendaCredit.received_at).toISOString()).toBe('2026-09-22T19:00:00.000Z')   // the day the check arrived
    expect((await db.query<any>(`SELECT payment_id, amount::text FROM credit_uses WHERE prepaid_credit_id = $1`, [f.ids.glendaCredit])).rows)
      .toEqual([{ payment_id: f.ids.glendaOct, amount: '460.00' }])

    // RV 52 and RV 33: $600 each, the surplus banked and linked, October's draw a use.
    for (const [credit, oct, banked, drawn] of [
      [f.ids.rv52Credit, f.ids.rv52Oct, '297.06', '14.70'], [f.ids.rv33Credit, f.ids.rv33Oct, '10.29', '5.22'],
    ]) {
      const rem = (await db.query<any>(`SELECT r.amount::text, r.unapplied_amount::text AS u FROM tenant_remittances r JOIN lease_prepaid_credits c ON c.source_remittance_id = r.id WHERE c.id = $1`, [credit])).rows
      expect(rem).toEqual([{ amount: '600.00', u: banked }])
      expect((await db.query<any>(`SELECT payment_id, amount::text, to_char(billing_month,'YYYY-MM-DD') AS m FROM credit_uses WHERE prepaid_credit_id = $1`, [credit])).rows)
        .toEqual([{ payment_id: oct, amount: drawn, m: '2026-10-01' }])
    }

    // MH 25's $10 is untouched (only its funding and receipt link are recorded).
    const mh25 = (await db.query<any>(`SELECT amount_remaining::text AS r, funded_by FROM lease_prepaid_credits WHERE id = $1`, [f.ids.mh25Credit])).rows[0]
    expect(mh25).toEqual({ r: '10.00', funded_by: 'landlord' })
    expect(r.invariants.ok).toBe(true)
  })

  it('writes one receipt per desk action with money; prior arrangements and $0 actions get none', async () => {
    await fixture()
    const r = await runBackfill()
    // Kim 3 rows, Russ 2, RV 33 4, Todd 1, RV 52 2, MH 25 1 = 6 receipts for 13 rows.
    expect(r.receipts).toHaveLength(6)
    expect(r.receipts.reduce((s, x) => s + x.rows, 0)).toBe(13)
    expect(r.skippedActions).toHaveLength(1)
    const prior = await db.query(
      `SELECT 1 FROM payments p JOIN remittance_applications a ON a.payment_id = p.id WHERE p.manual_method = 'prior_arrangement'`)
    expect(prior.rowCount).toBe(0)
    expect(r.uses).toHaveLength(8)   // Kim 1, Russ 3, the four Oct 1 draws
    expect(r.receipts.every(x => x.method !== 'prior_arrangement')).toBe(true)
  })

  it('refuses a credit-settled row it does not know, and writes nothing', async () => {
    const f = await fixture()
    await db.query(
      `INSERT INTO payments (unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description, settled_at, notes)
       SELECT unit_id, lease_id, tenant_id, landlord_id, 'utility', 12, 'settled', '2026-10-01', 'UTILITY', now(), 'covered by account credit'
         FROM payments WHERE id = $1`, [f.ids.toddOct])
    await expect(runBackfill()).rejects.toBeInstanceOf(BackfillRefused)
    await expect(runBackfill()).rejects.toThrow(/does not know that spend/)
    expect((await db.query(`SELECT 1 FROM credit_uses`)).rowCount).toBe(0)
    expect((await db.query(`SELECT 1 FROM tenant_remittances WHERE notes LIKE 'Desk receipt recorded from history%'`)).rowCount).toBe(0)
  })

  it('refuses a credit whose spends it cannot explain (a desk payment netted by unknown credit)', async () => {
    const f = await fixture()
    // History the backfill cannot explain (an old-code spend with no trace): written
    // the way the old code wrote it, so it needs the history bypass once C0 is on.
    await tx(c => asHistory(c, async () => {
      await c.query(`UPDATE lease_prepaid_credits SET amount_remaining = 0 WHERE id = $1`, [f.ids.mh25Credit])
    }))
    await expect(runBackfill()).rejects.toThrow(/only \$0\.00 explained/)
  })

  // S655 review: the funding stamp (step 1) moves updated_at to the run's time
  // before the void (step 4) read it, so the $0.55 was dated by the backfill run.
  it("Kim's withdrawn $0.55 is dated when Nic zeroed it, not when the backfill ran", async () => {
    await fixture()
    const zeroedAt = '2026-10-03 11:09:46.700475-07'
    await db.query(`UPDATE lease_prepaid_credits SET updated_at = $2::timestamptz WHERE id = $1`, [KIM.roundUp, zeroedAt])
    const r = await runBackfill()
    expect(r.voided).toHaveLength(1)
    const at = await db.query<any>(`SELECT voided_at = $2::timestamptz AS same FROM lease_prepaid_credits WHERE id = $1`, [KIM.roundUp, zeroedAt])
    expect(at.rows[0].same).toBe(true)
  })

  it('without a recorded time, a withdrawn credit keeps the time it was zeroed by hand (its updated_at before the run)', async () => {
    await fixture()
    const zeroedAt = '2026-10-02 16:45:00.123456-07'
    await db.query(`UPDATE lease_prepaid_credits SET updated_at = $2::timestamptz WHERE id = $1`, [KIM.roundUp, zeroedAt])
    const history = {
      ...PRODUCTION_HISTORY,
      voidedPaidAhead: PRODUCTION_HISTORY.voidedPaidAhead.map(v => ({ ...v, voidedAt: undefined })),
    }
    await tx(c => runMoneyHistoryBackfill(c, history))
    const at = await db.query<any>(
      `SELECT voided_at = $2::timestamptz AS same, updated_at > voided_at AS touched_after FROM lease_prepaid_credits WHERE id = $1`,
      [KIM.roundUp, zeroedAt])
    expect(at.rows[0]).toEqual({ same: true, touched_after: true })
  })

  it('I1–I3 pass after backfill, and a second run writes nothing', async () => {
    await fixture()
    await runBackfill()
    const again = await runBackfill()
    expect(again.receipts).toEqual([])
    expect(again.uses).toEqual([])
    expect(again.fundingStamped).toEqual([])
    expect(again.voided).toEqual([])
    expect(again.tenantCreditsVoided).toEqual([])
    const inv = await tx(c => checkMoneyInvariants(c, { only: ['I1', 'I2', 'I3', 'I4', 'I6'] }))
    expect(inv.results.map(x => [x.id, x.violations])).toEqual([['I1', 0], ['I2', 0], ['I3', 0], ['I4', 0], ['I6', 0]])
  })
})

// The DRY=0 precondition (header, step 4): a withdrawn credit keeps its
// amount_remaining, so no app read of paid-ahead balances may count it.
describe('DRY=0 refuses while a paid-ahead balance read does not leave out withdrawn credit', () => {
  const src = (sql: string) => `export async function f() {\n  return query(\`${sql}\`, [id])\n}\n`

  it('flags a sum, a pool read and a zeroing write with no voided_at filter, on the line that names the table', () => {
    const text =
      `// lease_prepaid_credits amount_remaining in a comment is not a read\n` +
      src(`SELECT l.id,\n  COALESCE((SELECT SUM(c.amount_remaining) FROM lease_prepaid_credits c\n            WHERE c.lease_id = l.id AND c.amount_remaining > 0), 0) AS left,\n  (SELECT 1 FROM tenant_credits t WHERE t.voided_at IS NULL) AS other\n FROM leases l`) +
      src(`SELECT id, amount_remaining::text FROM lease_prepaid_credits WHERE lease_id = $1 AND amount_remaining > 0 FOR UPDATE`) +
      src(`UPDATE lease_prepaid_credits SET amount_remaining = 0 WHERE id = ANY($1::uuid[])`)
    const found = unfilteredPaidAheadReads('routes/x.ts', text)
    expect(found.map(f => f.line)).toEqual([4, 10, 13])
    expect(found[0].sql).toMatch(/^SELECT SUM\(c\.amount_remaining\) FROM lease_prepaid_credits c/)
  })

  it('passes reads that filter voided_at, writes of a new credit, and reads that never touch the balance', () => {
    const text =
      src(`SELECT COALESCE(SUM(amount_remaining), 0) FROM lease_prepaid_credits WHERE lease_id = $1 AND voided_at IS NULL`) +
      src(`SELECT x FROM t WHERE EXISTS (SELECT 1 FROM lease_prepaid_credits c WHERE c.lease_id = t.id AND c.voided_at IS NULL AND c.amount_remaining > 0)`) +
      src(`INSERT INTO lease_prepaid_credits (lease_id, tenant_id, amount_original, amount_remaining) VALUES ($1, $2, $3, $3)`) +
      src(`SELECT SUM(c.amount_original) FROM lease_prepaid_credits c WHERE c.lease_id = $1`) +
      src(`SELECT id, amount_remaining, voided_at FROM lease_prepaid_credits WHERE source_remittance_id = $1 FOR UPDATE`)
    expect(unfilteredPaidAheadReads('services/y.ts', text)).toEqual([])
  })

  it('scans the app tree, never tests, migrations or scripts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paid-ahead-readers-'))
    try {
      const bad = src(`SELECT SUM(amount_remaining) FROM lease_prepaid_credits WHERE lease_id = $1`)
      for (const f of ['routes/a.ts', 'routes/a.test.ts', 'db/migrations/x.ts', 'scripts/s.ts', 'test/h.ts', 'services/ok.ts']) {
        fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true })
        fs.writeFileSync(path.join(root, f), f === 'services/ok.ts' ? 'export const n = 1\n' : bad)
      }
      expect(unfilteredPaidAheadReaders(root).map(r => `${r.file}:${r.line}`)).toEqual(['routes/a.ts:2'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
