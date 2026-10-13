/**
 * S652 — a sale nobody signed ends with its paper.
 *
 * Found clearing Lot 1 at Country Acres: voiding an unsigned installment
 * agreement left its sale at 'pending_signature' forever, and one live sale per
 * unit meant the unit could never be drafted again. The fix is a trigger, so
 * these tests void three different ways and expect the same result from each.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db, query } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease, seedLeaseTenant } from '../test/dbHelpers'
import { voidDocument, HOME_SALE_VOIDED_CHARGE_REASON } from './voidDocument'
import { lockLeaseHousehold } from './unwindIssuedLease'
import { householdLockKey } from '../services/moneyPredicates'
import { voidedKeptVsDeleted } from '../test/voidedChargeTotals'

let f: { landlordId: string; unitId: string; tenantId: string }

beforeEach(async () => {
  await cleanupAllSchema()
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const ll = await seedLandlord(client)
    const propertyId = await seedProperty(client, {
      landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId, state: 'IL' })
    const unitId = await seedUnit(client, { propertyId, landlordId: ll.landlordId, unitType: 'mobile_home' })
    const tenantId = await seedTenant(client)
    await client.query('COMMIT')
    f = { landlordId: ll.landlordId, unitId, tenantId }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
})

async function agreementWithSale(status: 'pending_signature' | 'active' = 'pending_signature') {
  const d = await query<{ id: string }>(
    `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
     VALUES ($1,$2,'Installment contract','purchase_agreement','sent') RETURNING *`,
    [f.landlordId, f.unitId])
  const h = await query<{ id: string }>(
    `INSERT INTO home_sale_contracts
       (unit_id, tenant_id, landlord_id, sale_price, down_payment, financed_amount,
        annual_interest_rate, term_months, monthly_payment, start_month, status,
        installments_total, purchase_document_id)
     VALUES ($1,$2,$3,11000,0,11000,0,55,200,'2026-11-01',$4,55,$5) RETURNING id`,
    [f.unitId, f.tenantId, f.landlordId, status, d[0].id])
  return { doc: d[0] as any, saleId: h[0].id }
}
const saleStatus = async (id: string) =>
  (await query<{ status: string }>(`SELECT status FROM home_sale_contracts WHERE id=$1`, [id]))[0].status

describe('voiding an unsigned installment agreement', () => {
  it('cancels the sale it was for — through the void button\'s own steps', async () => {
    const { doc, saleId } = await agreementWithSale()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await voidDocument(client.query.bind(client) as any, doc, 'redrafting')
      await client.query('COMMIT')
    } finally { client.release() }
    expect(await saleStatus(saleId)).toBe('cancelled')
  })

  it('cancels it however the void happens — the 48-hour timeout writes the status directly', async () => {
    // The scheduler's timeout path never calls voidDocument. The trigger is
    // what makes it right anyway.
    const { doc, saleId } = await agreementWithSale()
    await query(`UPDATE lease_documents SET status='voided', voided_at=now() WHERE id=$1`, [doc.id])
    expect(await saleStatus(saleId)).toBe('cancelled')
  })

  it('frees the unit to be drafted again — the thing that was actually broken', async () => {
    const first = await agreementWithSale()
    await query(`UPDATE lease_documents SET status='voided' WHERE id=$1`, [first.doc.id])
    // One live sale per unit: before the fix this second draft was refused.
    const second = await agreementWithSale()
    expect(await saleStatus(second.saleId)).toBe('pending_signature')
  })

  // 10/12: "signed for" now means the BUYER signed. The landlord's signature
  // alone starts a sale billing, and voiding that paper ends the sale (below).
  it('never touches a sale the buyer signed for', async () => {
    const { doc, saleId } = await agreementWithSale('active')
    await query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, email, name, token, status, signed_at)
       SELECT $1, t.user_id, 'primary', 'pat@example.com', 'Pat', gen_random_uuid()::text, 'signed', now()
         FROM tenants t WHERE t.id = $2`, [doc.id, f.tenantId])
    await query(`UPDATE lease_documents SET status='voided' WHERE id=$1`, [doc.id])
    expect(await saleStatus(saleId)).toBe('active')
  })

  it('leaves a sale on some OTHER document alone', async () => {
    const { saleId } = await agreementWithSale()
    const other = await query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status)
       VALUES ($1,$2,'Lot lease','original_lease','sent') RETURNING id`, [f.landlordId, f.unitId])
    await query(`UPDATE lease_documents SET status='voided' WHERE id=$1`, [other[0].id])
    expect(await saleStatus(saleId)).toBe('pending_signature')
  })
})

// S655 lock order: household, then the document, then its rows — the order the
// scheduler's 15-minute cancel and its hold take. The manual void used to write
// lease_tenants rows before the unwind locked the household, so a manual void
// and the scheduler on the same document could deadlock.
describe('the void takes the household lock first, as the scheduler does', () => {
  async function addendumAdd() {
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      const leaseId = await seedLease(client, { unitId: f.unitId, landlordId: f.landlordId })
      await seedLeaseTenant(client, { leaseId, tenantId: f.tenantId })
      const joiner = await seedTenant(client)
      const doc = (await client.query(
        `INSERT INTO lease_documents (landlord_id, unit_id, lease_id, title, document_type, status)
         VALUES ($1,$2,$3,'Add a tenant','addendum_add','sent') RETURNING *`,
        [f.landlordId, f.unitId, leaseId])).rows[0]
      await client.query(
        `INSERT INTO lease_tenants (lease_id, tenant_id, role, status, add_document_id)
         VALUES ($1,$2,'co_tenant','pending_add',$3)`, [leaseId, joiner, doc.id])
      await client.query('COMMIT')
      return { doc, leaseId }
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
  }
  const HELD = `SELECT EXISTS (
      SELECT 1 FROM pg_locks
       WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted AND objsubid = 1
         AND classid = ((hashtextextended($1, 0) >> 32) & 4294967295)::oid
         AND objid   = (hashtextextended($1, 0) & 4294967295)::oid) AS held`

  it('holds the household lock before it writes any lease_tenants row', async () => {
    const { doc } = await addendumAdd()
    const key = householdLockKey(f.tenantId, f.landlordId)
    const client = await db.connect()
    const heldAtCascade: boolean[] = []
    try {
      await client.query('BEGIN')
      const q = async (sql: string, params?: any[]) => {
        if (/UPDATE\s+lease_tenants/i.test(sql)) {
          heldAtCascade.push((await client.query(HELD, [key])).rows[0].held)
        }
        return client.query(sql, params)
      }
      await voidDocument(q as any, doc, 'redrafting')
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
    expect(heldAtCascade).toEqual([true])
    const rows = await query<{ status: string }>(
      `SELECT status FROM lease_tenants WHERE add_document_id = $1`, [doc.id])
    expect(rows.map(r => r.status)).toEqual(['void'])
  })

  it('runs cleanly inside a transaction that already took the scheduler order (household, then document)', async () => {
    const { doc, leaseId } = await addendumAdd()
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await lockLeaseHousehold(client.query.bind(client) as any, leaseId)
      const live = (await client.query(
        `SELECT * FROM lease_documents WHERE id = $1 FOR UPDATE`, [doc.id])).rows[0]
      await voidDocument(client.query.bind(client) as any, live, 'canceled')
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
    const d = await query<{ status: string }>(`SELECT status FROM lease_documents WHERE id = $1`, [doc.id])
    expect(d[0].status).toBe('voided')
  })

  it('refuses on the live row: a copy read before a tenant signed is not voided', async () => {
    const { doc } = await addendumAdd()
    await query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, email, name, token, status, signed_at)
       SELECT $1, t.user_id, 'tenant', 'pat@example.com', 'Pat', gen_random_uuid()::text, 'signed', now()
         FROM tenants t WHERE t.id = $2`, [doc.id, f.tenantId])
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await expect(voidDocument(client.query.bind(client) as any, doc, 'redrafting'))
        .rejects.toThrow('Cannot void after a tenant has signed')
      await client.query('ROLLBACK')
    } finally { client.release() }
  })

  it('refuses a document already voided since the caller read it', async () => {
    const { doc } = await addendumAdd()
    await query(`UPDATE lease_documents SET status = 'voided' WHERE id = $1`, [doc.id])
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await expect(voidDocument(client.query.bind(client) as any, doc, 'again'))
        .rejects.toThrow('Document is already voided')
      await client.query('ROLLBACK')
    } finally { client.release() }
  })
})

/**
 * 10/12 (Nic): "We need people to be billed correctly regardless of signing
 * status." The landlord's signature now starts a home sale billing, so an
 * installment contract only he has signed can have an active sale with a home
 * payment on the buyer's bill — and can still be voided. Voiding it takes the
 * sale back: the payment comes off the bill and the sale is cancelled, or the
 * void is refused in plain words when money already moved.
 */
describe('voiding an installment contract only the landlord signed', () => {
  async function billingSale(o: { start?: boolean } = {}) {
    const { activateHomeSaleContract, createHomeSaleContract } = await import('../services/homeSale')
    const month = (await query<{ m: string }>(
      `SELECT to_char(date_trunc('month', (NOW() AT TIME ZONE p.timezone)::date), 'YYYY-MM-DD') AS m
         FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = $1`, [f.unitId]))[0].m
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await client.query(`UPDATE units SET dwelling_ownership = 'landlord' WHERE id = $1`, [f.unitId])
      const leaseId = await seedLease(client, { unitId: f.unitId, landlordId: f.landlordId, rentAmount: 450 })
      await seedLeaseTenant(client, { leaseId, tenantId: f.tenantId, role: 'primary' })
      const invoiceId = (await client.query(
        `INSERT INTO invoices (landlord_id, tenant_id, lease_id, unit_id, invoice_number, due_date, subtotal_rent, total_amount, status)
         VALUES ($1,$2,$3,$4,'INV-VOID-HS',$5,450,450,'pending') RETURNING id`,
        [f.landlordId, f.tenantId, leaseId, f.unitId, month])).rows[0].id as string
      await client.query(
        `INSERT INTO payments (invoice_id, unit_id, lease_id, tenant_id, landlord_id, type, amount, status, due_date, entry_description)
         VALUES ($1,$2,$3,$4,$5,'rent',450,'pending',$6,'RENT')`,
        [invoiceId, f.unitId, leaseId, f.tenantId, f.landlordId, month])
      const doc = (await client.query(
        `INSERT INTO lease_documents (landlord_id, unit_id, lease_id, title, document_type, status)
         VALUES ($1,$2,$3,'Installment contract','purchase_agreement','in_progress') RETURNING *`,
        [f.landlordId, f.unitId, leaseId])).rows[0]
      await client.query(
        `INSERT INTO lease_document_signers (document_id, user_id, role, email, name, token, status, signed_at, order_index)
         SELECT $1, l.user_id, 'landlord', 'owner@example.com', 'Owner', gen_random_uuid()::text, 'signed', now(), 1
           FROM landlords l WHERE l.id = $2`, [doc.id, f.landlordId])
      await client.query(
        `INSERT INTO lease_document_signers (document_id, user_id, role, email, name, token, status, order_index)
         SELECT $1, t.user_id, 'primary', 'pat@example.com', 'Pat', gen_random_uuid()::text, 'sent', 2
           FROM tenants t WHERE t.id = $2`, [doc.id, f.tenantId])
      const k = await createHomeSaleContract(client, {
        unitId: f.unitId, leaseId: null, tenantId: f.tenantId, landlordId: f.landlordId,
        salePrice: 1800, downPayment: 0, annualInterestRate: 0, termMonths: 12, startMonth: month,
        planType: 'flat', pendingSignature: true,
      })
      await client.query(`UPDATE home_sale_contracts SET purchase_document_id = $2 WHERE id = $1`, [k.id, doc.id])
      await client.query('COMMIT')
      // His signature started it: this month's $150 is on the bill.
      if (o.start !== false) expect((await activateHomeSaleContract(doc.id)).activated).toBe(true)
      return { doc, saleId: k.id as string, invoiceId }
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
  }
  // 10/12 (Nic): a home payment the void takes off is VOIDED as a record,
  // never deleted — a live line is one not voided.
  const billOf = async (id: string) => (await query<any>(
    `SELECT status, total_amount::float AS total, subtotal_home_payments::float AS home,
            (SELECT COUNT(*)::int FROM payments p WHERE p.invoice_id = i.id AND p.type = 'home_payment'
                                                    AND p.status <> 'voided') AS home_lines,
            (SELECT COUNT(*)::int FROM payments p WHERE p.invoice_id = i.id AND p.type = 'home_payment'
                                                    AND p.status = 'voided') AS voided_home_lines
       FROM invoices i WHERE id = $1`, [id]))[0]

  it('takes the home payment off the bill and cancels the sale', async () => {
    const { doc, saleId, invoiceId } = await billingSale()
    expect(await billOf(invoiceId)).toMatchObject({ total: 600, home: 150, home_lines: 1 })
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await voidDocument(client.query.bind(client) as any, doc, 'wrong terms')
      await client.query('COMMIT')
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
    expect(await saleStatus(saleId)).toBe('cancelled')
    expect(await billOf(invoiceId)).toMatchObject({ status: 'pending', total: 450, home: 0, home_lines: 0, voided_home_lines: 1 })
    const unbilled = await query<any>(
      `SELECT 1 FROM home_sale_installments WHERE contract_id = $1 AND payment_id IS NOT NULL`, [saleId])
    expect(unbilled).toHaveLength(0)
    // The home payment is kept, at its amount, stamped with why it is not owed,
    // and still names its installment.
    const kept = await query<any>(
      `SELECT p.amount::float AS amount, p.void_reason, p.voided_at IS NOT NULL AS stamped,
              (SELECT i.contract_id FROM home_sale_installments i WHERE i.id = p.home_sale_installment_id) AS contract_id
         FROM payments p WHERE p.invoice_id = $1 AND p.type = 'home_payment'`, [invoiceId])
    expect(kept).toEqual([{ amount: 150, void_reason: HOME_SALE_VOIDED_CHARGE_REASON, stamped: true, contract_id: saleId }])
    // Every figure reads as it did when the home payment was deleted.
    const who = (await query<any>(`SELECT landlord_id, tenant_id FROM invoices WHERE id = $1`, [invoiceId]))[0]
    const r = await voidedKeptVsDeleted(who.landlord_id, who.tenant_id)
    expect(r.voidedRows).toBe(1)
    expect(r.kept).toEqual(r.deleted)
  })

  it('refuses once a home payment from it was paid — nothing changes', async () => {
    const { doc, saleId, invoiceId } = await billingSale()
    await query(`UPDATE payments SET status = 'settled', settled_at = now() WHERE invoice_id = $1 AND type = 'home_payment'`, [invoiceId])
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await expect(voidDocument(client.query.bind(client) as any, doc, 'wrong terms'))
        .rejects.toThrow(/already been paid/)
      await client.query('ROLLBACK')
    } finally { client.release() }
    expect(await saleStatus(saleId)).toBe('active')
    expect(await billOf(invoiceId)).toMatchObject({ home: 150, home_lines: 1 })
  })

  it('a void that skips those steps is stopped by the database, not left billing', async () => {
    const { doc, saleId } = await billingSale()
    await expect(query(`UPDATE lease_documents SET status='voided' WHERE id=$1`, [doc.id]))
      .rejects.toThrow(/still has home payments/)
    expect(await saleStatus(saleId)).toBe('active')
  })

  it('refuses a sale already recorded as paid off — the home has passed to the buyer', async () => {
    const { doc, saleId, invoiceId } = await billingSale()
    await query(`UPDATE home_sale_contracts SET status = 'paid_off', paid_off_at = now() WHERE id = $1`, [saleId])
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await expect(voidDocument(client.query.bind(client) as any, doc, 'wrong terms'))
        .rejects.toThrow(/already recorded as paid off/)
      await client.query('ROLLBACK')
    } finally { client.release() }
    expect(await saleStatus(saleId)).toBe('paid_off')
    expect(await billOf(invoiceId)).toMatchObject({ home: 150, home_lines: 1 })
  })

  /** Waits until some other connection is blocked on a lock. */
  async function someoneWaits(kind: 'advisory' | 'tuple' | 'transactionid' | 'any' = 'any') {
    for (let i = 0; i < 200; i++) {
      const n = (await query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND ($1 = 'any' OR wait_event = $1)`, [kind]))[0].n
      if (n > 0) return
      await new Promise(r => setTimeout(r, 25))
    }
    throw new Error('nothing ever waited on the lock')
  }

  it('a bill attach that waited out the void puts nothing back on the bill', async () => {
    const { attachDueInstallmentsToOpenInvoices } = await import('../services/homeSale')
    const { doc, saleId, invoiceId } = await billingSale()
    // The void runs and has taken the line off, not yet committed. It holds
    // the buyer's household lock.
    const voiding = await db.connect()
    try {
      await voiding.query('BEGIN')
      await voidDocument(voiding.query.bind(voiding) as any, doc, 'wrong terms')
      // Meanwhile an attach starts: it still sees the sale as billing and
      // waits for the household lock.
      const attaching = attachDueInstallmentsToOpenInvoices(saleId)
      await someoneWaits('advisory')
      await voiding.query('COMMIT')
      expect((await attaching).attached).toEqual([])
    } catch (e) { await voiding.query('ROLLBACK').catch(() => {}); throw e } finally { voiding.release() }
    expect(await saleStatus(saleId)).toBe('cancelled')
    expect(await billOf(invoiceId)).toMatchObject({ total: 450, home: 0, home_lines: 0, voided_home_lines: 1 })
  })

  it('a void outside voidDocument that races the start sees the lines the start wrote, and stops', async () => {
    const { activateHomeSaleContractIn } = await import('../services/homeSale')
    const { doc, saleId, invoiceId } = await billingSale({ start: false })
    // The landlord's signature is starting the sale: schedule written and this
    // month's line on the bill, not yet committed (the start holds the sale's
    // row lock).
    const starting = await db.connect()
    try {
      await starting.query('BEGIN')
      expect((await activateHomeSaleContractIn(starting as any, doc.id))?.attached).toHaveLength(1)
      // A void that skips voidDocument (a direct status write) lands now.
      const voidedDirectly = query(`UPDATE lease_documents SET status = 'voided' WHERE id = $1`, [doc.id])
        .then(() => 'voided', (e: any) => String(e?.message ?? e))
      await someoneWaits()
      await starting.query('COMMIT')
      expect(await voidedDirectly).toMatch(/still has home payments/)
    } catch (e) { await starting.query('ROLLBACK').catch(() => {}); throw e } finally { starting.release() }
    // Not a cancelled sale with its charge left on the bill.
    expect(await saleStatus(saleId)).toBe('active')
    expect(await billOf(invoiceId)).toMatchObject({ home: 150, home_lines: 1 })
  })

  it('a landlord-only sale with nothing on a bill yet is cancelled however the void happens', async () => {
    const { doc, saleId } = await agreementWithSale('active')
    await query(
      `INSERT INTO lease_document_signers (document_id, user_id, role, email, name, token, status, signed_at)
       SELECT $1, l.user_id, 'landlord', 'owner@example.com', 'Owner', gen_random_uuid()::text, 'signed', now()
         FROM landlords l WHERE l.id = $2`, [doc.id, f.landlordId])
    await query(`UPDATE lease_documents SET status='voided' WHERE id=$1`, [doc.id])
    expect(await saleStatus(saleId)).toBe('cancelled')
  })
})
