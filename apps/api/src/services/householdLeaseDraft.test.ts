// S605 (Nic): the invite → lease chain.
//
// "It should predraft all the leases linked to those units, send them to me as
// the landlord for signature, and then I verify everything in the workflow there
// and sign and send to each tenant."
//
// And the constraint that makes it usable by anyone: "this workflow shouldn't be
// based on [my template being imported], it should just be linked to the default
// template for that unit type."
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant } from '../test/dbHelpers'
import { draftHouseholdLease, resolveHouseholdByEmail, draftPendingForUnitType, draftAllPendingLeases } from './householdLeaseDraft'
import { createDocumentRecord } from '../routes/esign'

beforeEach(async () => { await cleanupAllSchema() })
afterAll(async () => { await db.end() })

async function seedCtx(unitType = 'rv_spot') {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    const unitId = await seedUnit(c, { propertyId, landlordId })
    await c.query(`UPDATE units SET unit_type=$2 WHERE id=$1`, [unitId, unitType])
    const tenantId = await seedTenant(c)
    await c.query('COMMIT')
    const { rows: [t] } = await db.query<any>(
      `SELECT u.id AS user_id, u.email FROM tenants t JOIN users u ON u.id=t.user_id WHERE t.id=$1`, [tenantId])
    return { userId, landlordId, propertyId, unitId, tenantUserId: t.user_id, tenantEmail: t.email }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

async function seedTemplate(landlordId: string, unitType: string, opts: { pdf?: string | null } = {}) {
  const { rows: [tpl] } = await db.query<any>(
    `INSERT INTO lease_templates (landlord_id, name, unit_type, is_unit_type_default, base_pdf_url, is_active)
     VALUES ($1,$2,$3,TRUE,$4,TRUE) RETURNING id`,
    [landlordId, `${unitType} lease`, unitType, opts.pdf === undefined ? '/uploads/lease.pdf' : opts.pdf])
  return tpl.id
}

const resident = (c: any) => [{ userId: c.tenantUserId, name: 'Jane Renter', email: c.tenantEmail, phone: null }]

describe('draftHouseholdLease', () => {
  // The whole point of the generic build: a landlord who hasn't set a template
  // is TOLD what to configure, not failed silently — and the same call starts
  // producing drafts the moment they do.
  it('no template for the unit type → clear reason naming the type', async () => {
    const c = await seedCtx('rv_spot')
    const res = await draftHouseholdLease({ landlordId: c.landlordId, unitId: c.unitId, residents: resident(c) })
    expect(res.drafted).toBe(false)
    if (!res.drafted) expect(res.reason).toMatch(/rv_spot|template/i)
  })

  it('drafts once the unit type has a default template', async () => {
    const c = await seedCtx('rv_spot')
    await seedTemplate(c.landlordId, 'rv_spot')
    const res = await draftHouseholdLease({ landlordId: c.landlordId, unitId: c.unitId, residents: resident(c) })
    expect(res.drafted).toBe(true)
  })

  // The safety check Nic asked for: "the landlord will get a last glance at
  // every lease... so if there's any problems, the landlord can cancel."
  it('LANDLORD signs first, residents after', async () => {
    const c = await seedCtx('rv_spot')
    await seedTemplate(c.landlordId, 'rv_spot')
    const res = await draftHouseholdLease({ landlordId: c.landlordId, unitId: c.unitId, residents: resident(c) })
    expect(res.drafted).toBe(true)
    if (!res.drafted) return
    const { rows } = await db.query<any>(
      `SELECT role, order_index FROM lease_document_signers WHERE document_id=$1 ORDER BY order_index`,
      [res.documentId])
    expect(rows[0].role).toBe('landlord')
    expect(Number(rows[0].order_index)).toBe(1)
    expect(rows[1].role).toBe('tenant')
    expect(Number(rows[1].order_index)).toBe(2)
  })

  it('a household of two puts both residents on ONE document', async () => {
    const c = await seedCtx('rv_spot')
    await seedTemplate(c.landlordId, 'rv_spot')
    // A second real user for the co-resident.
    const { rows: [u2] } = await db.query<any>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ('john-co@mailer-test.co','x','tenant','John','Renter') RETURNING id`)
    await db.query(`INSERT INTO tenants (user_id) VALUES ($1)`, [u2.id])

    const res = await draftHouseholdLease({
      landlordId: c.landlordId, unitId: c.unitId,
      residents: [
        { userId: c.tenantUserId, name: 'Jane Renter', email: c.tenantEmail, phone: null },
        { userId: u2.id, name: 'John Renter', email: 'john-co@mailer-test.co', phone: null },
      ],
    })
    expect(res.drafted).toBe(true)
    if (!res.drafted) return
    const { rows } = await db.query<any>(
      `SELECT role FROM lease_document_signers WHERE document_id=$1 ORDER BY order_index`, [res.documentId])
    expect(rows).toHaveLength(3)                 // landlord + two residents
    expect(rows.filter((r: any) => r.role === 'tenant')).toHaveLength(2)
  })

  // Re-inviting must not stack a second unsigned lease on the same unit.
  it('does not draft twice for the same unit', async () => {
    const c = await seedCtx('rv_spot')
    await seedTemplate(c.landlordId, 'rv_spot')
    await draftHouseholdLease({ landlordId: c.landlordId, unitId: c.unitId, residents: resident(c) })
    const again = await draftHouseholdLease({ landlordId: c.landlordId, unitId: c.unitId, residents: resident(c) })
    expect(again.drafted).toBe(false)
    if (!again.drafted) expect(again.reason).toMatch(/already awaiting/i)
  })

  it('a template with no uploaded PDF does not draft', async () => {
    const c = await seedCtx('rv_spot')
    await seedTemplate(c.landlordId, 'rv_spot', { pdf: null })
    const res = await draftHouseholdLease({ landlordId: c.landlordId, unitId: c.unitId, residents: resident(c) })
    expect(res.drafted).toBe(false)
  })

  // A template set for ANOTHER unit type must not be used — that is the whole
  // reason the resolver keys on unit type.
  it('a template for a different unit type is not used', async () => {
    const c = await seedCtx('rv_spot')
    await seedTemplate(c.landlordId, 'mobile_home')
    const res = await draftHouseholdLease({ landlordId: c.landlordId, unitId: c.unitId, residents: resident(c) })
    expect(res.drafted).toBe(false)
  })

  it('resolveHouseholdByEmail only returns this landlord’s tenants', async () => {
    const c = await seedCtx('rv_spot')
    const mine = await resolveHouseholdByEmail(c.landlordId, [c.tenantEmail])
    expect(mine).toHaveLength(1)
    const stranger = await resolveHouseholdByEmail(c.landlordId, ['nobody@mailer-test.co'])
    expect(stranger).toHaveLength(0)
  })
})


// ── S605 (Nic): the template arrives LATE and drafting catches up ───────────
// "If somebody does forget to add the template first... have something to
// remember which unit the tenant was invited to, so that when they add it, it
// refires."
describe('draftPendingForUnitType — retry when the template lands', () => {
  const waitFor = (landlordId: string, unitId: string, userId: string, order = 0) =>
    db.query(
      `INSERT INTO pending_lease_drafts (landlord_id, unit_id, tenant_user_id, household_order)
       VALUES ($1,$2,$3,$4)`, [landlordId, unitId, userId, order])

  it('drafts the waiting household once a default template exists', async () => {
    const c = await seedCtx('rv_spot')
    await waitFor(c.landlordId, c.unitId, c.tenantUserId)

    // No template yet — nothing drafts.
    const before = await draftPendingForUnitType({ landlordId: c.landlordId, unitType: 'rv_spot' })
    expect(before.drafted).toBe(0)

    // Landlord sets it up; the retry fires.
    await seedTemplate(c.landlordId, 'rv_spot')
    const after = await draftPendingForUnitType({ landlordId: c.landlordId, unitType: 'rv_spot' })
    expect(after.drafted).toBe(1)

    const { rows } = await db.query<any>(
      `SELECT resolved_at, resolved_document_id FROM pending_lease_drafts WHERE unit_id=$1`, [c.unitId])
    expect(rows[0].resolved_at).not.toBeNull()
    expect(rows[0].resolved_document_id).not.toBeNull()
  })

  // Running it twice must not produce a second lease for the same unit.
  it('is idempotent — a second run drafts nothing more', async () => {
    const c = await seedCtx('rv_spot')
    await waitFor(c.landlordId, c.unitId, c.tenantUserId)
    await seedTemplate(c.landlordId, 'rv_spot')
    await draftPendingForUnitType({ landlordId: c.landlordId, unitType: 'rv_spot' })
    const again = await draftPendingForUnitType({ landlordId: c.landlordId, unitType: 'rv_spot' })
    expect(again.drafted).toBe(0)
    const { rows } = await db.query<any>(
      `SELECT COUNT(*)::int AS n FROM lease_documents WHERE unit_id=$1`, [c.unitId])
    expect(rows[0].n).toBe(1)
  })

  // A template for one unit type must not sweep up units of another.
  it('only touches units of the matching type', async () => {
    const c = await seedCtx('rv_spot')
    await waitFor(c.landlordId, c.unitId, c.tenantUserId)
    await seedTemplate(c.landlordId, 'mobile_home')
    const res = await draftPendingForUnitType({ landlordId: c.landlordId, unitType: 'mobile_home' })
    expect(res.drafted).toBe(0)
    const { rows } = await db.query<any>(
      `SELECT resolved_at FROM pending_lease_drafts WHERE unit_id=$1`, [c.unitId])
    expect(rows[0].resolved_at).toBeNull()      // still waiting, untouched
  })

  it('keeps household order — the first invited holds the lease', async () => {
    const c = await seedCtx('rv_spot')
    const { rows: [u2] } = await db.query<any>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ('second@mailer-test.co','x','tenant','Second','Person') RETURNING id`)
    await db.query(`INSERT INTO tenants (user_id) VALUES ($1)`, [u2.id])
    await waitFor(c.landlordId, c.unitId, c.tenantUserId, 0)
    await waitFor(c.landlordId, c.unitId, u2.id, 1)
    await seedTemplate(c.landlordId, 'rv_spot')

    const res = await draftPendingForUnitType({ landlordId: c.landlordId, unitType: 'rv_spot' })
    expect(res.drafted).toBe(1)
    const { rows } = await db.query<any>(
      `SELECT s.role, s.user_id, s.order_index FROM lease_document_signers s
        JOIN lease_documents d ON d.id = s.document_id
       WHERE d.unit_id=$1 ORDER BY s.order_index`, [c.unitId])
    expect(rows[0].role).toBe('landlord')
    expect(rows[1].user_id).toBe(c.tenantUserId)   // invited first → signer 2
    expect(rows[2].user_id).toBe(u2.id)
  })
})


// S605 (Nic): "if one unit doesn't draft, make sure it doesn't stop the rest" —
// and, just as importantly, that the landlord is told WHICH one and why. A bare
// count is a silent partial failure.
describe('draftPendingForUnitType — partial failure is reported, not swallowed', () => {
  it('drafts the others and names the unit that was skipped', async () => {
    const c = await seedCtx('rv_spot')
    await seedTemplate(c.landlordId, 'rv_spot')

    // A SECOND rv_spot unit on the same property, also waiting.
    const { rows: [u2] } = await db.query<any>(
      `INSERT INTO units (property_id, landlord_id, unit_number, rent_amount, unit_type)
       VALUES ($1,$2,'RV 02',500,'rv_spot') RETURNING id`, [c.propertyId, c.landlordId])
    const { rows: [t2] } = await db.query<any>(
      `INSERT INTO users (email, password_hash, role, first_name, last_name)
       VALUES ('rv2@mailer-test.co','x','tenant','Two','Renter') RETURNING id`)
    await db.query(`INSERT INTO tenants (user_id) VALUES ($1)`, [t2.id])

    await db.query(
      `INSERT INTO pending_lease_drafts (landlord_id, unit_id, tenant_user_id, household_order)
       VALUES ($1,$2,$3,0), ($1,$4,$5,0)`,
      [c.landlordId, c.unitId, c.tenantUserId, u2.id, t2.id])

    // Unit 1 already has an unsigned lease sent MANUALLY through e-sign — so its
    // pending rows are still open, but the duplicate guard will refuse to draft
    // a second one. This is the realistic per-unit skip; a lease drafted through
    // this service resolves its own rows and never reaches the retry at all.
    await db.query(
      `INSERT INTO lease_documents (landlord_id, unit_id, title, status, document_type, delivery_mode)
       VALUES ($1,$2,'Manually sent lease','sent','original_lease','agreement')`,
      [c.landlordId, c.unitId])

    const res = await draftPendingForUnitType({ landlordId: c.landlordId, unitType: 'rv_spot' })
    expect(res.drafted).toBe(1)                    // RV 02 still went through
    expect(res.skipped).toBe(1)
    // and the landlord can see exactly which one, and why
    expect(res.skippedUnits).toHaveLength(1)
    expect(res.skippedUnits[0].unitNumber).toBeTruthy()
    expect(res.skippedUnits[0].reason).toMatch(/already awaiting/i)
  })
})


// S605 (Nic): "if a previous run drafted the lease, then it should know that now
// that it's saving it. So your second error shouldn't ever happen." Right — the
// skip is only reachable while a unit's waiting rows are left open, and no path
// should leave them open once a lease exists for that unit.
describe('any lease for a unit closes its waiting invites', () => {
  it('a lease sent by hand resolves the pending rows', async () => {
    const c = await seedCtx('rv_spot')
    await db.query(
      `INSERT INTO pending_lease_drafts (landlord_id, unit_id, tenant_user_id, household_order)
       VALUES ($1,$2,$3,0)`, [c.landlordId, c.unitId, c.tenantUserId])

    // Sent through the normal e-sign creation path, not the draft service.
    const client = await db.connect()
    try {
      await client.query('BEGIN')
      await createDocumentRecord(client, {
        landlordId: c.landlordId, templateId: null, unitId: c.unitId, leaseId: null,
        title: 'Hand-sent lease', basePdfUrl: null, documentType: 'original_lease' as any,
        targetLeaseTenantId: null, promoteLeaseTenantId: null,
        signers: [{ userId: c.userId, role: 'landlord', name: 'LL', email: 'll@mailer-test.co', orderIndex: 1 }],
      })
      await client.query('COMMIT')
    } finally { client.release() }

    const { rows } = await db.query<any>(
      `SELECT resolved_at FROM pending_lease_drafts WHERE unit_id=$1`, [c.unitId])
    expect(rows[0].resolved_at).not.toBeNull()

    // …so a later template save finds nothing waiting and skips nothing.
    await seedTemplate(c.landlordId, 'rv_spot')
    const res = await draftPendingForUnitType({ landlordId: c.landlordId, unitType: 'rv_spot' })
    expect(res.drafted).toBe(0)
    expect(res.skipped).toBe(0)
    expect(res.skippedUnits).toEqual([])
  })
})


// S605 (Nic): "on the off chance that something does fail, what initiates the
// retry?" An hourly sweep, so nothing depends on the landlord re-saving a
// template to unstick a queue.
describe('draftAllPendingLeases — the hourly backstop', () => {
  it('drafts a household that was waiting, with no template save involved', async () => {
    const c = await seedCtx('rv_spot')
    await db.query(
      `INSERT INTO pending_lease_drafts (landlord_id, unit_id, tenant_user_id, household_order)
       VALUES ($1,$2,$3,0)`, [c.landlordId, c.unitId, c.tenantUserId])
    await seedTemplate(c.landlordId, 'rv_spot')

    const res = await draftAllPendingLeases()
    expect(res.drafted).toBe(1)
    const { rows } = await db.query<any>(
      `SELECT resolved_at FROM pending_lease_drafts WHERE unit_id=$1`, [c.unitId])
    expect(rows[0].resolved_at).not.toBeNull()
  })

  it('a settled queue is a no-op', async () => {
    const res = await draftAllPendingLeases()
    expect(res.drafted).toBe(0)
    expect(res.skipped).toBe(0)
  })

  // Still no template — must stay waiting rather than being consumed.
  it('leaves a household waiting when the template is still missing', async () => {
    const c = await seedCtx('rv_spot')
    await db.query(
      `INSERT INTO pending_lease_drafts (landlord_id, unit_id, tenant_user_id, household_order)
       VALUES ($1,$2,$3,0)`, [c.landlordId, c.unitId, c.tenantUserId])
    const res = await draftAllPendingLeases()
    expect(res.drafted).toBe(0)
    const { rows } = await db.query<any>(
      `SELECT resolved_at FROM pending_lease_drafts WHERE unit_id=$1`, [c.unitId])
    expect(rows[0].resolved_at).toBeNull()   // still queued for the next sweep
  })
})
