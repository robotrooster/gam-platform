/**
 * S641 — the signing package.
 *
 * Nic: "some things are pertinent to some tenants and some things are not, all
 * at the same property… having it all bundled together in a package type format
 * would make life easier."
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedLease } from '../test/dbHelpers'
import {
  resolvePackageForUnit, setTemplateProperties, templatePropertyIds,
  itemsDueAtRenewal, bumpTemplateVersion,
} from './signingPackages'

beforeEach(async () => { await cleanupAllSchema() })

interface World {
  landlordId: string; userId: string
  parkA: string; parkB: string; parkC: string
  mhUnit: string; rvUnit: string
  leaseId: string
  packageId: string
  tpl: Record<string, string>
}

async function world(): Promise<World> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const ll = await seedLandlord(c)
    const mk = async (name: string) => {
      const id = await seedProperty(c, { landlordId: ll.landlordId, ownerUserId: ll.userId, managedByUserId: ll.userId })
      await c.query(`UPDATE properties SET name=$2 WHERE id=$1`, [id, name])
      return id
    }
    const parkA = await mk('Mountain View')
    const parkB = await mk('Oak Park')
    const parkC = await mk('Country Acres')

    const mhUnit = await seedUnit(c, { propertyId: parkA, landlordId: ll.landlordId })
    await c.query(`UPDATE units SET unit_type='mobile_home', unit_number='MH 1' WHERE id=$1`, [mhUnit])
    const rvUnit = await seedUnit(c, { propertyId: parkA, landlordId: ll.landlordId })
    await c.query(`UPDATE units SET unit_type='rv_spot', unit_number='RV 1' WHERE id=$1`, [rvUnit])
    const leaseId = await seedLease(c, { unitId: mhUnit, landlordId: ll.landlordId })

    const tpl: Record<string, string> = {}
    const mkTpl = async (key: string, name: string, purpose: string, unitType: string | null) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO lease_templates (landlord_id, name, purpose, unit_type) VALUES ($1,$2,$3,$4) RETURNING id`,
        [ll.landlordId, name, purpose, unitType])
      tpl[key] = r.rows[0].id
    }
    await mkTpl('lease',      'Mobile Home Lease',      'lease',            'mobile_home')
    await mkTpl('policy',     'AZ Statement of Policy', 'state_disclosure', null)
    await mkTpl('rules',      'Park Rules',             'park_rules',       null)
    await mkTpl('installment','Installment Sale',       'installment_sale', null)
    await mkTpl('parking',    'Assigned Parking Rules', 'park_rules',       null)

    const pk = await c.query<{ id: string }>(
      `INSERT INTO document_packages (landlord_id, name, unit_type, is_default)
       VALUES ($1,'AZ Park-Owned Homes','mobile_home',TRUE) RETURNING id`, [ll.landlordId])

    const addItem = async (tId: string, order: number, behavior: string, required = false) => {
      await c.query(
        `INSERT INTO document_package_items (package_id, template_id, sort_order, renewal_behavior, required)
         VALUES ($1,$2,$3,$4,$5)`, [pk.rows[0].id, tId, order, behavior, required])
    }
    await addItem(tpl.lease, 0, 'with_lease', true)
    await addItem(tpl.installment, 1, 'once_per_tenancy')
    await addItem(tpl.policy, 2, 'once_per_tenancy')
    await addItem(tpl.rules, 3, 'on_version_change')
    await addItem(tpl.parking, 4, 'on_version_change')

    await c.query('COMMIT')
    return { landlordId: ll.landlordId, userId: ll.userId, parkA, parkB, parkC,
             mhUnit, rvUnit, leaseId, packageId: pk.rows[0].id, tpl }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

describe('resolving a package for a unit', () => {
  it('picks the default for the unit type and returns items in order', async () => {
    const w = await world()
    const r = await resolvePackageForUnit({ landlordIds: [w.landlordId], unitId: w.mhUnit })
    expect(r!.name).toBe('AZ Park-Owned Homes')
    expect(r!.items.map(i => i.templateName)).toEqual([
      'Mobile Home Lease', 'Installment Sale', 'AZ Statement of Policy',
      'Park Rules', 'Assigned Parking Rules',
    ])
  })

  it('suggests everything unpinned — a disclosure is reusable anywhere', async () => {
    const w = await world()
    const r = await resolvePackageForUnit({ landlordIds: [w.landlordId], unitId: w.mhUnit })
    const policy = r!.items.find(i => i.templateName === 'AZ Statement of Policy')!
    expect(policy.suggested).toBe(true)
  })

  // Nic: "if I have parking rules at two of my properties and not at a third, I
  // wanna be able to pin it to multiple properties and have it not go to the third."
  it('a template pinned to other properties is not suggested here', async () => {
    const w = await world()
    await setTemplateProperties(w.tpl.parking, [w.parkB, w.parkC])
    const r = await resolvePackageForUnit({ landlordIds: [w.landlordId], unitId: w.mhUnit })
    const parking = r!.items.find(i => i.templateName === 'Assigned Parking Rules')!
    expect(parking.suggested).toBe(false)
    expect(parking.reason).toBe('Not used at this property')
  })

  it('pins to MANY properties without a second upload', async () => {
    const w = await world()
    await setTemplateProperties(w.tpl.parking, [w.parkA, w.parkB])
    expect((await templatePropertyIds(w.tpl.parking)).sort())
      .toEqual([w.parkA, w.parkB].sort())

    const here = await resolvePackageForUnit({ landlordIds: [w.landlordId], unitId: w.mhUnit })
    expect(here!.items.find(i => i.templateName === 'Assigned Parking Rules')!.suggested).toBe(true)
  })

  it('one template serves many packages and is never locked by use', async () => {
    const w = await world()
    const second = await db.query<{ id: string }>(
      `INSERT INTO document_packages (landlord_id, name, unit_type) VALUES ($1,'AZ RV Spots','rv_spot') RETURNING id`,
      [w.landlordId])
    await db.query(
      `INSERT INTO document_package_items (package_id, template_id, sort_order, renewal_behavior)
       VALUES ($1,$2,0,'once_per_tenancy')`, [second.rows[0].id, w.tpl.policy])

    const r = await resolvePackageForUnit({ landlordIds: [w.landlordId], unitId: w.rvUnit, packageId: second.rows[0].id })
    expect(r!.items.map(i => i.templateName)).toEqual(['AZ Statement of Policy'])
  })

  it('a required item stays ticked even where inference would drop it', async () => {
    const w = await world()
    await setTemplateProperties(w.tpl.lease, [w.parkB])  // pinned away from this park
    const r = await resolvePackageForUnit({ landlordIds: [w.landlordId], unitId: w.mhUnit })
    const lease = r!.items.find(i => i.templateName === 'Mobile Home Lease')!
    expect(lease.required).toBe(true)
    expect(lease.suggested).toBe(true)
  })

  it('a template written for another unit type is offered, not blocked', async () => {
    const w = await world()
    const r = await resolvePackageForUnit({ landlordIds: [w.landlordId], unitId: w.rvUnit, packageId: w.packageId })
    const lease = r!.items.find(i => i.templateName === 'Mobile Home Lease')!
    // still present — the landlord decides, the platform does not gate
    expect(lease).toBeTruthy()
  })
})

describe('what comes back at renewal', () => {
  it('the lease renews; the installment contract does not', async () => {
    const w = await world()
    const due = await itemsDueAtRenewal({ packageId: w.packageId, leaseId: w.leaseId })
    const names = due.map(d => d.templateName)
    expect(names).toContain('Mobile Home Lease')
    expect(names).not.toContain('Installment Sale')
    expect(names).not.toContain('AZ Statement of Policy')
  })

  it('park rules come back only when a newer version exists', async () => {
    const w = await world()
    // they signed version 1 of the rules
    await db.query(
      `INSERT INTO lease_documents (landlord_id, lease_id, title, template_id, template_version, status)
       VALUES ($1,$2,'Park Rules',$3,1,'completed')`,
      [w.landlordId, w.leaseId, w.tpl.rules])

    let due = await itemsDueAtRenewal({ packageId: w.packageId, leaseId: w.leaseId })
    expect(due.map(d => d.templateName)).not.toContain('Park Rules')

    // landlord publishes a new version
    await bumpTemplateVersion(w.tpl.rules)
    due = await itemsDueAtRenewal({ packageId: w.packageId, leaseId: w.leaseId })
    const rules = due.find(d => d.templateName === 'Park Rules')!
    expect(rules.why).toBe('Updated since they signed it')
  })

  it('something never signed comes back regardless', async () => {
    const w = await world()
    const due = await itemsDueAtRenewal({ packageId: w.packageId, leaseId: w.leaseId })
    expect(due.find(d => d.templateName === 'Park Rules')!.why).toBe('Never signed')
  })
})

// S652 (Nic): "when no packet is set… allow you to create the packet from that point."
describe('building the default packet from filled slots, at the invite', () => {
  it('assembles lease + filled slots + government forms, saves it as the default, and is idempotent', async () => {
    const w = await world()
    // Drop the seeded default package so nothing resolves for the RV unit.
    await db.query(`UPDATE document_packages SET archived_at = NOW() WHERE landlord_id = $1`, [w.landlordId])
    const { buildDefaultPackageForUnit } = await import('./signingPackages')
    // Nic's properties all have their default lease template set; so does this one.
    await db.query(`UPDATE lease_templates SET is_unit_type_default = TRUE, base_pdf_url = '/uploads/mh.pdf', is_active = TRUE
                     WHERE landlord_id = $1 AND purpose = 'lease'`, [w.landlordId])
    const first = await buildDefaultPackageForUnit([w.landlordId], w.mhUnit)
    expect(first.packageId).toBeTruthy()
    expect((first as any).created).toBe(true)
    const items = (await db.query(
      `SELECT t.purpose FROM document_package_items i JOIN lease_templates t ON t.id = i.template_id
        WHERE i.package_id = $1 ORDER BY i.sort_order`, [first.packageId])).rows
    expect(items[0].purpose).toBe('lease')
    const pkg = (await db.query(`SELECT is_default, unit_type, state_code FROM document_packages WHERE id=$1`, [first.packageId])).rows[0]
    expect(pkg.is_default).toBe(true)
    expect(pkg.unit_type).toBe('mobile_home')
    // the unfiled documents that fit came along
    expect(items.map((i: any) => i.purpose)).toEqual(expect.arrayContaining(['lease', 'installment_sale', 'state_disclosure']))
    const again = await buildDefaultPackageForUnit([w.landlordId], w.mhUnit)
    expect(again.packageId).toBe(first.packageId)
    expect((again as any).created).toBe(false)
  })

  it('with no lease template for that kind of unit, says so and points at Templates', async () => {
    const w = await world()
    await db.query(`UPDATE document_packages SET archived_at = NOW() WHERE landlord_id = $1`, [w.landlordId])
    await db.query(`UPDATE lease_templates SET is_active = FALSE WHERE landlord_id = $1 AND purpose = 'lease'`, [w.landlordId])
    const { buildDefaultPackageForUnit } = await import('./signingPackages')
    const r = await buildDefaultPackageForUnit([w.landlordId], w.rvUnit)
    expect(r.packageId).toBeNull()
    expect((r as any).needsLease).toBe(true)
  })
})
