/**
 * S439 services-audit triplet slice — long-tail close-out continued.
 *
 *   - maintenanceRequests.ts (92 lines): createMaintenanceRequest
 *     (tenant access gate, attribution, comment seed, notification)
 *   - taxForms.ts (138 lines): getApplicableTaxForms (federal +
 *     state catalog filter by landlord context)
 *   - posTax.ts (208 lines): calculateCartTax (rate stacking, category
 *     match, property-bound vs landlord-wide fallback, cents rounding)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { routeMaintenanceNotificationMock } = vi.hoisted(() => ({
  routeMaintenanceNotificationMock: vi.fn(async () => undefined),
}))

vi.mock('./notifications', () => ({
  routeMaintenanceNotification: routeMaintenanceNotificationMock,
}))

import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant,
  seedLease, seedLeaseTenant,
} from '../test/dbHelpers'
import { createMaintenanceRequest } from './maintenanceRequests'
import { getApplicableTaxForms } from './taxForms'
import { calculateCartTax } from './posTax'

beforeEach(async () => {
  // taxForms reads state_tax_forms (production-seeded catalog); we isolate
  // via effective_year=2099 and clear those rows.
  await db.query(`DELETE FROM state_tax_forms WHERE effective_year=2099`)
  await cleanupAllSchema()
  routeMaintenanceNotificationMock.mockReset()
})

// ═════════════════════════ maintenanceRequests ═════════════════════════

describe('createMaintenanceRequest', () => {
  interface MaintCtx {
    landlordUserId: string
    landlordId:     string
    propertyId:     string
    unitId:         string
    tenantId:       string
    tenantUserId:   string
    leaseId:        string
  }

  async function seedMaintCtx(opts: { activeLease?: boolean } = {}): Promise<MaintCtx> {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId: landlordUserId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
      })
      const unitId = await seedUnit(c, { propertyId, landlordId })
      const tenantId = await seedTenant(c)
      const leaseId = await seedLease(c, {
        unitId, landlordId,
        status: opts.activeLease === false ? 'terminated' : 'active',
      })
      await seedLeaseTenant(c, { leaseId, tenantId, role: 'primary' })
      const { rows: [{ user_id }] } = await c.query<{ user_id: string }>(
        `SELECT user_id FROM tenants WHERE id=$1`, [tenantId])
      await c.query('COMMIT')
      return {
        landlordUserId, landlordId, propertyId, unitId, tenantId,
        tenantUserId: user_id, leaseId,
      }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  it('unit not found → 404', async () => {
    await expect(createMaintenanceRequest({
      unitId: '00000000-0000-0000-0000-000000000000',
      title: 'leak', description: 'sink leaking',
      actor: { userId: '00000000-0000-0000-0000-000000000000', role: 'landlord', profileId: 'x' },
    })).rejects.toThrow(/Unit not found/)
  })

  it('tenant not on the unit\'s active lease → 403', async () => {
    const ctx = await seedMaintCtx()
    // Use a DIFFERENT tenant id as the actor.
    const c = await db.connect()
    let strangerTenantId = '', strangerUserId = ''
    try {
      await c.query('BEGIN')
      strangerTenantId = await seedTenant(c)
      const { rows: [{ user_id }] } = await c.query<{ user_id: string }>(
        `SELECT user_id FROM tenants WHERE id=$1`, [strangerTenantId])
      strangerUserId = user_id
      await c.query('COMMIT')
    } finally { c.release() }
    await expect(createMaintenanceRequest({
      unitId: ctx.unitId, title: 'leak', description: 'leaking',
      actor: { userId: strangerUserId, role: 'tenant', profileId: strangerTenantId },
    })).rejects.toThrow(/not assigned to this unit/)
  })

  it('tenant on active lease → request created with tenant_id=self; notification fires', async () => {
    const ctx = await seedMaintCtx()
    const req = await createMaintenanceRequest({
      unitId: ctx.unitId, title: 'leak', description: 'sink leaking',
      priority: 'normal',
      actor: { userId: ctx.tenantUserId, role: 'tenant', profileId: ctx.tenantId },
    })
    expect(req.tenant_id).toBe(ctx.tenantId)
    expect(req.landlord_id).toBe(ctx.landlordId)
    expect(req.title).toBe('leak')
    expect(req.priority).toBe('normal')
    expect(routeMaintenanceNotificationMock).toHaveBeenCalledWith(req.id)
    // First comment seeded with the description.
    const { rows: [comment] } = await db.query<any>(
      `SELECT message, role FROM maintenance_comments WHERE request_id=$1`, [req.id])
    expect(comment.message).toMatch(/sink leaking/)
    expect(comment.role).toBe('tenant')
  })

  it('landlord caller: attribution falls back to v_unit_occupancy primary tenant', async () => {
    const ctx = await seedMaintCtx()
    const req = await createMaintenanceRequest({
      unitId: ctx.unitId, title: 'roof', description: 'roof check',
      actor: { userId: ctx.landlordUserId, role: 'landlord', profileId: ctx.landlordId },
    })
    expect(req.tenant_id).toBe(ctx.tenantId)
    const { rows: [comment] } = await db.query<any>(
      `SELECT role FROM maintenance_comments WHERE request_id=$1`, [req.id])
    expect(comment.role).toBe('landlord')
  })

  it('landlord caller + no primary tenant on unit → request still created with tenant_id NULL', async () => {
    const ctx = await seedMaintCtx({ activeLease: false })
    const req = await createMaintenanceRequest({
      unitId: ctx.unitId, title: 'vacant unit fix', description: 'paint',
      actor: { userId: ctx.landlordUserId, role: 'landlord', profileId: ctx.landlordId },
    })
    expect(req.tenant_id).toBeNull()
  })

  it('notification throw is swallowed — request still created', async () => {
    const ctx = await seedMaintCtx()
    routeMaintenanceNotificationMock.mockRejectedValueOnce(new Error('email down'))
    const req = await createMaintenanceRequest({
      unitId: ctx.unitId, title: 'leak', description: 'leaking',
      actor: { userId: ctx.tenantUserId, role: 'tenant', profileId: ctx.tenantId },
    })
    expect(req.id).toBeTruthy()
  })

  it('priority defaults to "normal" when omitted; photos default to []', async () => {
    const ctx = await seedMaintCtx()
    const req = await createMaintenanceRequest({
      unitId: ctx.unitId, title: 'x', description: 'y',
      actor: { userId: ctx.landlordUserId, role: 'landlord', profileId: ctx.landlordId },
    })
    expect(req.priority).toBe('normal')
    expect(req.photos).toEqual([])
  })
})

// ═════════════════════════ taxForms ═════════════════════════

describe('getApplicableTaxForms', () => {
  interface TaxCtx {
    landlordId: string
    landlordUserId: string
    propertyId: string
  }

  async function seedTaxCtx(opts: { propertyState?: string } = {}): Promise<TaxCtx> {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId: landlordUserId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
      })
      if (opts.propertyState) {
        await c.query(`UPDATE properties SET state=$2 WHERE id=$1`,
          [propertyId, opts.propertyState])
      }
      await c.query('COMMIT')
      return { landlordId, landlordUserId, propertyId }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  async function seedTaxForm(opts: {
    state: string
    formCode: string
    appliesTo: 'all_landlords' | 'with_employees_in_state' | 'with_property_in_state' | 'with_contractors_paid_600'
    category?: string
  }): Promise<void> {
    await db.query(
      `INSERT INTO state_tax_forms
         (state_code, form_code, form_name, agency, category, frequency,
          due_dates, applies_to, effective_year, filing_method)
       VALUES ($1, $2, 'Form ' || $2, 'IRS', $3, 'quarterly',
               '[{"label":"Q1","due":"2099-04-30"}]'::jsonb,
               $4, 2099, 'paper_form')`,
      [opts.state, opts.formCode, opts.category ?? 'withholding', opts.appliesTo])
  }

  it('all_landlords federal form always returned', async () => {
    const ctx = await seedTaxCtx()
    await seedTaxForm({ state: 'US', formCode: '941', appliesTo: 'all_landlords' })
    const forms = await getApplicableTaxForms(ctx.landlordId, 2099)
    expect(forms.map(f => f.form_code)).toContain('941')
  })

  it('with_employees_in_state federal form ONLY fires when landlord has active employees', async () => {
    const ctx = await seedTaxCtx()
    await seedTaxForm({ state: 'US', formCode: 'W2', appliesTo: 'with_employees_in_state' })
    // No employees seeded.
    expect((await getApplicableTaxForms(ctx.landlordId, 2099)).map(f => f.form_code)).not.toContain('W2')
    // Seed an active employee → form now applies.
    await db.query(
      `INSERT INTO books_employees (landlord_id, first_name, last_name, status)
       VALUES ($1, 'Test', 'Emp', 'active')`, [ctx.landlordId])
    expect((await getApplicableTaxForms(ctx.landlordId, 2099)).map(f => f.form_code)).toContain('W2')
  })

  it('inactive employees do NOT trigger with_employees_in_state', async () => {
    const ctx = await seedTaxCtx()
    await seedTaxForm({ state: 'US', formCode: 'W2', appliesTo: 'with_employees_in_state' })
    await db.query(
      `INSERT INTO books_employees (landlord_id, first_name, last_name, status)
       VALUES ($1, 'Test', 'Inactive', 'terminated')`, [ctx.landlordId])
    expect((await getApplicableTaxForms(ctx.landlordId, 2099)).map(f => f.form_code)).not.toContain('W2')
  })

  it('with_contractors_paid_600 fires only when a contractor\'s ytd_paid ≥ 600', async () => {
    const ctx = await seedTaxCtx()
    await seedTaxForm({ state: 'US', formCode: '1099NEC', appliesTo: 'with_contractors_paid_600' })
    // No contractor → excluded.
    expect((await getApplicableTaxForms(ctx.landlordId, 2099)).map(f => f.form_code)).not.toContain('1099NEC')
    // Contractor under threshold → still excluded.
    await db.query(
      `INSERT INTO books_contractors (landlord_id, first_name, last_name, ytd_paid)
       VALUES ($1, 'C', 'Low', 599.99)`, [ctx.landlordId])
    expect((await getApplicableTaxForms(ctx.landlordId, 2099)).map(f => f.form_code)).not.toContain('1099NEC')
    // Contractor at threshold → included.
    await db.query(
      `INSERT INTO books_contractors (landlord_id, first_name, last_name, ytd_paid)
       VALUES ($1, 'C', 'High', 600.00)`, [ctx.landlordId])
    expect((await getApplicableTaxForms(ctx.landlordId, 2099)).map(f => f.form_code)).toContain('1099NEC')
  })

  it('with_property_in_state form ONLY fires when landlord owns property in that state', async () => {
    const ctx = await seedTaxCtx({ propertyState: 'AZ' })
    await seedTaxForm({ state: 'AZ', formCode: 'A1QRT', appliesTo: 'with_property_in_state' })
    await seedTaxForm({ state: 'CA', formCode: 'DE9',   appliesTo: 'with_property_in_state' })
    const forms = await getApplicableTaxForms(ctx.landlordId, 2099)
    const codes = forms.map(f => f.form_code)
    expect(codes).toContain('A1QRT')   // AZ property → included
    expect(codes).not.toContain('DE9') // no CA property → excluded
  })

  it('different year → empty when no forms for that year', async () => {
    const ctx = await seedTaxCtx()
    await seedTaxForm({ state: 'US', formCode: '941', appliesTo: 'all_landlords' })
    const forms = await getApplicableTaxForms(ctx.landlordId, 2050)  // empty year
    expect(forms).toEqual([])
  })
})

// ═════════════════════════ posTax ═════════════════════════

describe('calculateCartTax', () => {
  interface PosCtx {
    landlordId: string
    landlordUserId: string
    propertyId: string
    categoryId: string
    snacksCategoryId: string
    waterItemId: string
    chipsItemId: string
  }

  async function seedPosCtx(): Promise<PosCtx> {
    const c = await db.connect()
    try {
      await c.query('BEGIN')
      const { userId: landlordUserId, landlordId } = await seedLandlord(c)
      const propertyId = await seedProperty(c, {
        landlordId, ownerUserId: landlordUserId, managedByUserId: landlordUserId,
      })
      const { rows: [{ id: beverageCat }] } = await c.query<{ id: string }>(
        `INSERT INTO pos_categories (landlord_id, name, property_id)
         VALUES ($1, 'Beverages', $2) RETURNING id`,
        [landlordId, propertyId])
      const { rows: [{ id: snacksCat }] } = await c.query<{ id: string }>(
        `INSERT INTO pos_categories (landlord_id, name, property_id)
         VALUES ($1, 'Snacks', $2) RETURNING id`,
        [landlordId, propertyId])
      const { rows: [{ id: water }] } = await c.query<{ id: string }>(
        `INSERT INTO pos_items
           (landlord_id, name, sell_price, property_id, category_id)
         VALUES ($1, 'Water Bottle', 1.00, $2, $3) RETURNING id`,
        [landlordId, propertyId, beverageCat])
      const { rows: [{ id: chips }] } = await c.query<{ id: string }>(
        `INSERT INTO pos_items
           (landlord_id, name, sell_price, property_id, category_id)
         VALUES ($1, 'Chips', 2.00, $2, $3) RETURNING id`,
        [landlordId, propertyId, snacksCat])
      await c.query('COMMIT')
      return {
        landlordId, landlordUserId, propertyId,
        categoryId: beverageCat, snacksCategoryId: snacksCat,
        waterItemId: water, chipsItemId: chips,
      }
    } catch (e) { await c.query('ROLLBACK'); throw e }
    finally { c.release() }
  }

  async function seedRate(ctx: PosCtx, opts: {
    rate: number
    appliesTo: string[]
    propertyId?: string | null
    active?: boolean
    name?: string
  }): Promise<string> {
    const { rows: [{ id }] } = await db.query<{ id: string }>(
      `INSERT INTO pos_tax_rates
         (landlord_id, name, rate, tax_type, applies_to, is_active, property_id)
       VALUES ($1, $2, $3, 'sales', $4, $5, $6) RETURNING id`,
      [ctx.landlordId,
       opts.name ?? `Rate ${opts.rate}`,
       opts.rate, opts.appliesTo,
       opts.active ?? true,
       opts.propertyId === undefined ? ctx.propertyId : opts.propertyId])
    return id
  }

  it('empty cart → zeros', async () => {
    const ctx = await seedPosCtx()
    const res = await calculateCartTax(ctx.landlordId, [])
    expect(res).toEqual({ subtotal: 0, taxAmount: 0, lines: [] })
  })

  it('phantom item id (not owned by landlord) → throws', async () => {
    const ctx = await seedPosCtx()
    await expect(calculateCartTax(ctx.landlordId, [
      { itemId: '00000000-0000-0000-0000-000000000000', qty: 1, unitPrice: 1 },
    ])).rejects.toThrow(/not owned by this landlord/)
  })

  it('single rate applies_to=["all"]: subtotal × rate, applied to every line', async () => {
    const ctx = await seedPosCtx()
    await seedRate(ctx, { rate: 0.0825, appliesTo: ['all'] })
    const res = await calculateCartTax(ctx.landlordId, [
      { itemId: ctx.waterItemId, qty: 2, unitPrice: 1 },   // subtotal 2 → tax 0.165 → 0.17
      { itemId: ctx.chipsItemId, qty: 1, unitPrice: 2 },   // subtotal 2 → tax 0.165 → 0.17
    ])
    expect(res.subtotal).toBe(4)
    expect(res.lines).toHaveLength(2)
    // Each line stacked 8.25% on $2 = $0.165 → rounded $0.17
    expect(res.lines[0].appliedRates).toHaveLength(1)
    expect(res.lines[0].taxAmount).toBeCloseTo(0.17, 2)
    expect(res.taxAmount).toBeCloseTo(0.34, 2)  // 0.17 + 0.17 (line-level rounding sums)
  })

  it('rate applies_to=["Beverages"]: applies to water but NOT chips (category-scoped)', async () => {
    const ctx = await seedPosCtx()
    await seedRate(ctx, { rate: 0.10, appliesTo: ['Beverages'] })
    const res = await calculateCartTax(ctx.landlordId, [
      { itemId: ctx.waterItemId, qty: 1, unitPrice: 10 },   // → tax 1.00
      { itemId: ctx.chipsItemId, qty: 1, unitPrice: 10 },   // → tax 0
    ])
    expect(res.lines[0].taxAmount).toBe(1)
    expect(res.lines[1].taxAmount).toBe(0)
    expect(res.lines[1].appliedRates).toEqual([])
    expect(res.taxAmount).toBe(1)
  })

  it('case-insensitive category match', async () => {
    const ctx = await seedPosCtx()
    await seedRate(ctx, { rate: 0.10, appliesTo: ['  BEVERAGES  '] })  // padding + caps
    const res = await calculateCartTax(ctx.landlordId, [
      { itemId: ctx.waterItemId, qty: 1, unitPrice: 10 },
    ])
    expect(res.lines[0].taxAmount).toBe(1)
  })

  it('multiple rates STACK on the same line', async () => {
    const ctx = await seedPosCtx()
    await seedRate(ctx, { rate: 0.05, appliesTo: ['all'],       name: 'State' })
    await seedRate(ctx, { rate: 0.02, appliesTo: ['Beverages'], name: 'City Bev' })
    await seedRate(ctx, { rate: 0.01, appliesTo: ['all'],       name: 'County' })
    const res = await calculateCartTax(ctx.landlordId, [
      { itemId: ctx.waterItemId, qty: 1, unitPrice: 100 },
    ])
    expect(res.lines[0].appliedRates).toHaveLength(3)
    expect(res.lines[0].taxAmount).toBe(8)  // 5 + 2 + 1
    expect(res.taxAmount).toBe(8)
  })

  it('inactive rates skipped', async () => {
    const ctx = await seedPosCtx()
    await seedRate(ctx, { rate: 0.10, appliesTo: ['all'], active: false })
    const res = await calculateCartTax(ctx.landlordId, [
      { itemId: ctx.waterItemId, qty: 1, unitPrice: 100 },
    ])
    expect(res.lines[0].appliedRates).toEqual([])
    expect(res.taxAmount).toBe(0)
  })

  it('property-bound rates WIN over landlord-wide for that property\'s items', async () => {
    const ctx = await seedPosCtx()
    // Landlord-wide rate 10% — would apply if no property-scoped set.
    await seedRate(ctx, {
      rate: 0.10, appliesTo: ['all'], propertyId: null, name: 'Landlord-wide',
    })
    // Property-scoped rate 5% — wins over landlord-wide for items on this property.
    await seedRate(ctx, {
      rate: 0.05, appliesTo: ['all'], propertyId: ctx.propertyId, name: 'Property',
    })
    const res = await calculateCartTax(ctx.landlordId, [
      { itemId: ctx.waterItemId, qty: 1, unitPrice: 100 },
    ])
    expect(res.lines[0].appliedRates).toHaveLength(1)
    expect(res.lines[0].appliedRates[0].name).toBe('Property')
    expect(res.lines[0].taxAmount).toBe(5)
  })

  it('falls back to landlord-wide when property has no bound rates', async () => {
    const ctx = await seedPosCtx()
    await seedRate(ctx, {
      rate: 0.10, appliesTo: ['all'], propertyId: null, name: 'Landlord-wide',
    })
    const res = await calculateCartTax(ctx.landlordId, [
      { itemId: ctx.waterItemId, qty: 1, unitPrice: 100 },
    ])
    expect(res.lines[0].appliedRates[0].name).toBe('Landlord-wide')
    expect(res.lines[0].taxAmount).toBe(10)
  })
})
