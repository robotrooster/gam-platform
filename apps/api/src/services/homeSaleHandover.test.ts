/**
 * 10/28 — THE TRAILER GOES WITH THE SPACE.
 *
 * Nic: "the new tenant is going to be making the remaining payments on the
 * trailer. So the contract needs to also have a takeover route, the same way
 * that a lease does. It's just a walk-away thing — like turning in your car
 * back to the dealership. They're just walking away."
 *
 * Designed 10/23 for Country Acres MH 28 (migration a_home_sale_changes_hands)
 * and never built: the table existed and not one of the three billing readers
 * had been taught to use it, so a handover row would have changed nothing at
 * all. These tests are about the money actually moving.
 *
 * The invariant that makes it safe: the CONTRACT never moves. Same sale price,
 * same monthly payment, same payments left, same original buyer on the row —
 * because tenant_id is a watched ledger column and re-pointing it would
 * re-project every month the first buyer paid as though the new one had.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'crypto'
import { db, getClient } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLeaseTenant } from '../test/dbHelpers'
import { attachDueInstallmentsToOpenInvoices, billDueHomeSaleInstallments } from './homeSale'
import { todayIn } from '../lib/timezone'

beforeEach(async () => { await cleanupAllSchema() })

// 11/01: plain calendar arithmetic on GAM's own day, with no Date in the middle.
// This used to setDate(1) on the bare wall clock in LOCAL time and then read the
// UTC day back, which after 5pm Phoenix returned the 2nd — and on the 1st of a
// month could return the wrong month entirely.
const MONTH = (offset: number) => {
  const [y, m] = todayIn(null).split('-').map(Number)
  const total = (y * 12 + (m - 1)) + offset
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`
}

/**
 * A home mid-purchase on a rented space, with the buyer living on it: 38 of
 * 120 payments made at $200/month, which is MH 28's real shape.
 */
async function homeBeingBoughtOnASpace() {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(client)
    const propertyId = await seedProperty(client, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(client, { propertyId, landlordId, rentAmount: 325 })
    await client.query(
      `UPDATE units SET dwelling_ownership = 'tenant', unit_type = 'mobile_home', status = 'active'
        WHERE id = $1`, [unitId])

    const buyerId = await seedTenant(client, { email: `buyer-${randomUUID()}@test.dev` })
    const lease = await client.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, status, lease_type, start_date, rent_amount,
                           signed_by_tenant, signed_by_landlord)
       VALUES ($1, $2, 'active', 'month_to_month', CURRENT_DATE - 400, 325, TRUE, TRUE)
       RETURNING id`, [unitId, landlordId])
    await seedLeaseTenant(client, { leaseId: lease.rows[0].id, tenantId: buyerId })

    const contract = await client.query<{ id: string }>(
      `INSERT INTO home_sale_contracts
         (unit_id, tenant_id, landlord_id, sale_price, financed_amount, term_months,
          monthly_payment, start_month, installments_total, status)
       VALUES ($1, $2, $3, 24000, 24000, 120, 200, $4::date, 120, 'active')
       RETURNING id`, [unitId, buyerId, landlordId, MONTH(-38)])
    const contractId = contract.rows[0].id

    // This month's payment and next month's, both unbilled.
    for (const [n, month] of [[39, MONTH(0)], [40, MONTH(1)]] as Array<[number, string]>) {
      await client.query(
        `INSERT INTO home_sale_installments
           (contract_id, installment_number, billing_month, amount,
            principal_portion, interest_portion, remaining_balance)
         VALUES ($1, $2, $3::date, 200, 200, 0, $4)`,
        [contractId, n, month, 24000 - 200 * n])
    }

    const takerId = await seedTenant(client, { email: `taker-${randomUUID()}@test.dev` })

    await client.query('COMMIT')
    return { landlordId, propertyId, unitId, buyerId, takerId, contractId, sittingLeaseId: lease.rows[0].id }
  } catch (e) { await client.query('ROLLBACK'); throw e } finally { client.release() }
}

const assume = (f: any, month: string, to?: string) => db.query(
  `INSERT INTO home_sale_assumptions
     (contract_id, landlord_id, from_tenant_id, to_tenant_id, effective_month)
   VALUES ($1, $2, $3, $4, date_trunc('month', $5::date)::date)`,
  [f.contractId, f.landlordId, f.buyerId, to ?? f.takerId, month])

/** Who each billed installment was charged to. */
const billedTo = async (contractId: string) => (await db.query<any>(
  `SELECT i.installment_number, p.tenant_id
     FROM home_sale_installments i
     JOIN payments p ON p.id = i.payment_id
    WHERE i.contract_id = $1
    ORDER BY i.installment_number`, [contractId])).rows

describe('who owes an installment after the home changes hands', () => {
  it('with no handover, the original buyer is billed — unchanged behaviour', async () => {
    const f = await homeBeingBoughtOnASpace()
    await attachDueInstallmentsToOpenInvoices(f.contractId)
    const rows = await billedTo(f.contractId)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.tenant_id).toBe(f.buyerId)
  })

  it('from the handover month on, the NEW resident is billed', async () => {
    const f = await homeBeingBoughtOnASpace()
    await assume(f, MONTH(0))
    await attachDueInstallmentsToOpenInvoices(f.contractId)
    const rows = await billedTo(f.contractId)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(r.tenant_id).toBe(f.takerId)
  })

  it('a handover NEXT month leaves this month with the person still here', async () => {
    const f = await homeBeingBoughtOnASpace()
    await assume(f, MONTH(1))
    // Bill both months: the morning run walks every due installment.
    await billDueHomeSaleInstallments(MONTH(1))
    const rows = await billedTo(f.contractId)
    const byNumber = Object.fromEntries(rows.map((r: any) => [r.installment_number, r.tenant_id]))
    expect(byNumber[39]).toBe(f.buyerId)   // the month they were still buying
    expect(byNumber[40]).toBe(f.takerId)   // the first month they are not
  })

  it('never re-bills a month the leaver already paid', async () => {
    const f = await homeBeingBoughtOnASpace()
    // This month goes out to the original buyer first…
    await attachDueInstallmentsToOpenInvoices(f.contractId)
    const before = await billedTo(f.contractId)
    const thisMonth = before.find((r: any) => r.installment_number === 39)
    expect(thisMonth.tenant_id).toBe(f.buyerId)
    // …then the home changes hands effective the SAME month.
    await assume(f, MONTH(0))
    await attachDueInstallmentsToOpenInvoices(f.contractId)
    const after = await billedTo(f.contractId)
    // Still one line for 39, still against the person who was billed it.
    expect(after.filter((r: any) => r.installment_number === 39)).toHaveLength(1)
    expect(after.find((r: any) => r.installment_number === 39).tenant_id).toBe(f.buyerId)
  })

  it('leaves the contract itself alone — the sale\'s history is not re-pointed', async () => {
    const f = await homeBeingBoughtOnASpace()
    await assume(f, MONTH(0))
    await attachDueInstallmentsToOpenInvoices(f.contractId)
    const c = (await db.query<any>(
      `SELECT tenant_id, sale_price::float AS sale_price, monthly_payment::float AS monthly_payment,
              installments_total, status
         FROM home_sale_contracts WHERE id = $1`, [f.contractId])).rows[0]
    // Nic: "it's just a ownership transfer straight across... The park just
    // wants what it was being sold for in the first place."
    expect(c.tenant_id).toBe(f.buyerId)       // the ORIGINAL buyer, for good
    expect(c.sale_price).toBe(24000)
    expect(c.monthly_payment).toBe(200)
    expect(c.installments_total).toBe(120)
    expect(c.status).toBe('active')
  })
})

/**
 * 10/28 (Nic) — A TAKEOVER IS A NEW CONTRACT THAT SUPERSEDES THE OLD ONE.
 *
 *   "It's a new lease, it's a new contract, it's a new whatever the landlord
 *    wants to set. It just supersedes the old one after signature."
 *
 * So two things must be true, and an earlier cut of this had the first one
 * wrong: signing for the SPACE moves no trailer payments by itself, and the
 * trailer moves when the installment paper in that same packet is signed.
 */
describe('signing for the space alone', () => {
  const replacementSignedFor = async (f: any, startIso: string) => {
    const r = await db.query<{ id: string }>(
      `INSERT INTO leases (unit_id, landlord_id, status, lease_type, start_date, rent_amount,
                           replaces_lease_id, signed_by_tenant, signed_by_landlord)
       VALUES ($1, $2, 'pending', 'month_to_month', $3::date, 325, $4, TRUE, TRUE)
       RETURNING id`, [f.unitId, f.landlordId, startIso, f.sittingLeaseId])
    await db.query(
      `INSERT INTO lease_tenants (lease_id, tenant_id, role, status)
       VALUES ($1, $2, 'primary', 'active')`, [r.rows[0].id, f.takerId])
    return r.rows[0].id
  }

  it('moves no trailer payments — they have not signed for the trailer', async () => {
    const f = await homeBeingBoughtOnASpace()
    const newLeaseId = await replacementSignedFor(f, MONTH(0))
    const { replacementTookOverSpot } = await import('./spotSuccession')
    const out = await replacementTookOverSpot({ query: db.query.bind(db) } as any, newLeaseId)
    expect(out).toBeTruthy()          // the SPACE did hand over

    // …and the purchase did not. Nic: "why would a person make the payments if
    // they're not on the contract?"
    expect((await db.query<any>(
      `SELECT 1 FROM home_sale_assumptions WHERE contract_id = $1`, [f.contractId])).rows).toHaveLength(0)
    const c = (await db.query<any>(
      `SELECT status, tenant_id FROM home_sale_contracts WHERE id = $1`, [f.contractId])).rows[0]
    expect(c.status).toBe('active')
    expect(c.tenant_id).toBe(f.buyerId)
    // The person on the contract is still the one billed.
    await attachDueInstallmentsToOpenInvoices(f.contractId)
    for (const r of await billedTo(f.contractId)) expect(r.tenant_id).toBe(f.buyerId)
  })
})

describe('the installment paper in the takeover packet', () => {
  /** The new contract the landlord's typed terms produced, awaiting the buyer. */
  const takeoverPaperFor = async (f: any, opts: { monthly: number; months: number; signed: boolean }) => {
    const doc = await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status,
                                    supersedes_home_sale_contract_id)
       VALUES ($1, $2, 'Installment contract — takeover', 'purchase_agreement', 'in_progress', $3)
       RETURNING id`, [f.landlordId, f.unitId, f.contractId])
    const documentId = doc.rows[0].id
    const lu = (await db.query<any>(
      `SELECT u.id FROM users u JOIN landlords l ON l.user_id = u.id WHERE l.id = $1`, [f.landlordId])).rows[0]
    const tu = (await db.query<any>(`SELECT user_id FROM tenants WHERE id = $1`, [f.takerId])).rows[0]
    for (const [role, userId, done] of [['landlord', lu.id, true], ['primary', tu.user_id, opts.signed]] as any[]) {
      await db.query(
        `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status, signed_at)
         VALUES ($1,$2,$3,'S','s@test.dev',1,$4,'sent',$5)`,
        [documentId, userId, role, `${documentId}-${role}`, done ? new Date() : null])
    }
    // The contract the landlord's signature wrote from the boxes he typed: his
    // choice of terms, not a copy of the old one.
    const fresh = await db.query<{ id: string }>(
      `INSERT INTO home_sale_contracts
         (unit_id, tenant_id, landlord_id, sale_price, financed_amount, term_months,
          monthly_payment, start_month, installments_total, status, purchase_document_id)
       VALUES ($1, $2, $3, $4, $4, $5, $6, date_trunc('month', NOW())::date, $5, 'pending_signature', $7)
       RETURNING id`,
      [f.unitId, f.takerId, f.landlordId, opts.monthly * opts.months, opts.months, opts.monthly, documentId])
    return { documentId, newContractId: fresh.rows[0].id }
  }

  it('starts the new contract and retires the old one', async () => {
    const f = await homeBeingBoughtOnASpace()
    // The landlord chose a different payment — his call, not ours.
    const { documentId, newContractId } = await takeoverPaperFor(f, { monthly: 250, months: 60, signed: true })
    const { startTakeoverContractAndRetireTheOld } = await import('./homeSale')
    const out = await startTakeoverContractAndRetireTheOld(documentId)
    expect(out.started).toBe(true)

    const old = (await db.query<any>(
      `SELECT status, superseded_by_contract_id, tenant_id FROM home_sale_contracts WHERE id = $1`,
      [f.contractId])).rows[0]
    expect(old.status).toBe('superseded')
    expect(old.superseded_by_contract_id).toBe(newContractId)
    expect(old.tenant_id).toBe(f.buyerId)      // never re-pointed; their months stay theirs

    const fresh = (await db.query<any>(
      `SELECT status, tenant_id, monthly_payment::float AS monthly FROM home_sale_contracts WHERE id = $1`,
      [newContractId])).rows[0]
    expect(fresh.tenant_id).toBe(f.takerId)
    expect(fresh.monthly).toBe(250)            // the landlord's terms, not the old ones
  })

  it('the retired contract stops billing, so the trailer is never billed twice', async () => {
    const f = await homeBeingBoughtOnASpace()
    const { documentId } = await takeoverPaperFor(f, { monthly: 200, months: 82, signed: true })
    const { startTakeoverContractAndRetireTheOld } = await import('./homeSale')
    await startTakeoverContractAndRetireTheOld(documentId)
    // The morning run walks active contracts only.
    await billDueHomeSaleInstallments(MONTH(1))
    expect(await billedTo(f.contractId)).toHaveLength(0)
  })

  it('does nothing until the buyer signs it', async () => {
    const f = await homeBeingBoughtOnASpace()
    const { documentId } = await takeoverPaperFor(f, { monthly: 250, months: 60, signed: false })
    const { startTakeoverContractAndRetireTheOld } = await import('./homeSale')
    const out = await startTakeoverContractAndRetireTheOld(documentId)
    expect(out.started).toBe(false)
    const old = (await db.query<any>(`SELECT status FROM home_sale_contracts WHERE id = $1`, [f.contractId])).rows[0]
    expect(old.status).toBe('active')          // still billing the person on it
  })

  it('retires nothing twice', async () => {
    const f = await homeBeingBoughtOnASpace()
    const { documentId, newContractId } = await takeoverPaperFor(f, { monthly: 200, months: 82, signed: true })
    const { startTakeoverContractAndRetireTheOld } = await import('./homeSale')
    await startTakeoverContractAndRetireTheOld(documentId)
    const again = await startTakeoverContractAndRetireTheOld(documentId)
    expect(again.started).toBe(true)
    expect(again.newContractId).toBe(newContractId)
  })
})

/**
 * 10/28 (Nic): "when somebody's taking over and making the payments, they
 * become the new owner. So they need to sign that as well. The original buyer
 * is not on the contract at that point. They are replacing the person on the
 * contract. Why would a person make the payments if they're not on the
 * contract?"
 *
 * The payoff is where that stops being a wording question and becomes a title:
 * whoever was buying the home at the end owns it. Before this, the payoff read
 * the contract's FIRST signer, so a trailer somebody else finished paying off
 * would have been recorded against the person who walked away from it.
 */
describe('who owns the home when it is paid off', () => {
  const payOffEverything = async (f: any) => {
    // Every installment settled: the reconcile is what flips ownership.
    await db.query(`UPDATE home_sale_installments SET settled_off_platform_at = NOW()
                     WHERE contract_id = $1`, [f.contractId])
    await db.query(`UPDATE home_sale_contracts SET installments_total = (
                      SELECT COUNT(*) FROM home_sale_installments WHERE contract_id = $1)
                    WHERE id = $1`, [f.contractId])
    const { reconcileHomeSaleContract } = await import('./homeSale')
    await reconcileHomeSaleContract(f.contractId)
  }

  const ownerUserId = async (unitId: string) => (await db.query<any>(
    `SELECT owner_user_id FROM home_ownerships
      WHERE unit_id = $1 AND released_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [unitId])).rows[0]?.owner_user_id ?? null

  const userOf = async (tenantId: string) => (await db.query<any>(
    `SELECT user_id FROM tenants WHERE id = $1`, [tenantId])).rows[0].user_id

  it('goes to the person who took over the payments, not the one who left', async () => {
    const f = await homeBeingBoughtOnASpace()
    await assume(f, MONTH(0))
    await payOffEverything(f)
    expect(await ownerUserId(f.unitId)).toBe(await userOf(f.takerId))
  })

  it('goes to the original buyer when it never changed hands', async () => {
    const f = await homeBeingBoughtOnASpace()
    await payOffEverything(f)
    expect(await ownerUserId(f.unitId)).toBe(await userOf(f.buyerId))
  })
})

/**
 * 10/28, LIVE FAILURE. Blue signed the installment contract in his takeover
 * packet and got a critical alert: "Installment contract signed but its terms
 * did not record — This unit already has an active home-sale contract."
 *
 * createHomeSaleContract refuses a second purchase on a home that already has
 * one, which is right — except the one it was counting is the very contract
 * this paper exists to retire, and that one must keep billing until the new
 * resident signs. The carve-out added earlier was on the PRE-signature check in
 * the route; this guard sits deeper, inside the write, and was still counting it.
 *
 * The tests above never caught it because they built the new contract by hand
 * in the fixture and so never went through the write at all. This one drives
 * the real path: typed terms on a signed document become a contract.
 */
describe('the takeover contract is written while the old one is still billing', () => {
  const paperWithTypedTerms = async (f: any, opts: { supersedes: boolean }) => {
    const doc = await db.query<{ id: string }>(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, document_type, status,
                                    supersedes_home_sale_contract_id)
       VALUES ($1, $2, 'Installment contract', 'purchase_agreement', 'in_progress', $3)
       RETURNING id`, [f.landlordId, f.unitId, opts.supersedes ? f.contractId : null])
    const documentId = doc.rows[0].id
    // The buyer has to be ON the paper — the terms record against whoever signs
    // as primary, which is the person taking the home over.
    const lu = (await db.query<any>(
      `SELECT u.id FROM users u JOIN landlords l ON l.user_id = u.id WHERE l.id = $1`, [f.landlordId])).rows[0]
    const tu = (await db.query<any>(`SELECT user_id FROM tenants WHERE id = $1`, [f.takerId])).rows[0]
    for (const [role, userId] of [['landlord', lu.id], ['primary', tu.user_id]] as any[]) {
      await db.query(
        `INSERT INTO lease_document_signers (document_id, user_id, role, name, email, order_index, token, status, signed_at)
         VALUES ($1,$2,$3,'S','s@test.dev',1,$4,'signed',NOW())`,
        [documentId, userId, role, `${documentId}-${role}`])
    }
    // What the landlord typed on his own form — his terms, not the old ones.
    for (const [col, val] of Object.entries({
      sale_price: '16400.00', sale_down_payment: '0.00', sale_term_months: '36',
      sale_interest_rate: '0', sale_first_payment_month: MONTH(0),
    })) {
      await db.query(
        `INSERT INTO lease_document_fields (document_id, field_type, signer_role, lease_column, value, required)
         VALUES ($1,'text','landlord',$2,$3,FALSE)`, [documentId, col, val])
    }
    return documentId
  }

  it('records the terms even though the home already has a purchase on it', async () => {
    const f = await homeBeingBoughtOnASpace()
    const documentId = await paperWithTypedTerms(f, { supersedes: true })
    const { applySaleTermsFromDocument } = await import('./homeSale')
    const out = await applySaleTermsFromDocument(documentId)
    expect(out.contractId).toBeTruthy()

    // Two contracts on the home now: the old one still billing, the new one
    // waiting for the buyer's signature. Neither has touched the other.
    const rows = (await db.query<any>(
      `SELECT id, status FROM home_sale_contracts WHERE unit_id = $1 ORDER BY created_at`, [f.unitId])).rows
    expect(rows).toHaveLength(2)
    expect(rows.find((r: any) => r.id === f.contractId).status).toBe('active')
    expect(rows.find((r: any) => r.id === out.contractId).status).toBe('pending_signature')
  })

  it('still refuses an UNRELATED second purchase on the same home', async () => {
    const f = await homeBeingBoughtOnASpace()
    const documentId = await paperWithTypedTerms(f, { supersedes: false })
    const { applySaleTermsFromDocument } = await import('./homeSale')
    await expect(applySaleTermsFromDocument(documentId)).rejects.toThrow(/already has an active home-sale contract/i)
  })
})
