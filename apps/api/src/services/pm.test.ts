/**
 * S428 services-audit slice 5b (of 3): pm.ts `getPmCompanyForProperty`.
 *
 * 3-way resolution priority:
 *   1. property.pm_company_id (explicit) → source='property'
 *   2. landlord.default_pm_company_id    → source='landlord_default'
 *   3. neither set                       → source=null
 *
 * The invitation lifecycle (sendPropertyInvitation,
 * acceptPropertyInvitation, rejectPropertyInvitation,
 * revokePropertyInvitation, expireStaleInvitations) is a larger
 * surface and deferred to a follow-on slice.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty,
} from '../test/dbHelpers'
import { getPmCompanyForProperty } from './pm'

beforeEach(async () => {
  await cleanupAllSchema()
})

async function seedPmCompany(landlordId: string): Promise<string> {
  const { rows: [{ id }] } = await db.query<{ id: string }>(
    `INSERT INTO pm_companies (name) VALUES ('S428 PM Co') RETURNING id`)
  return id
}

async function seedPmFeePlan(pmCompanyId: string): Promise<string> {
  const { rows: [{ id }] } = await db.query<{ id: string }>(
    `INSERT INTO pm_fee_plans (pm_company_id, name, fee_type, percent)
     VALUES ($1, 'Standard', 'percent_of_rent', 8) RETURNING id`,
    [pmCompanyId])
  return id
}

describe('getPmCompanyForProperty', () => {
  it('property-level assignment wins → source=property + plan_id passed through', async () => {
    const c = await db.connect()
    let propertyId = ''; let pmCompanyId = ''; let planId = ''
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      propertyId = await seedProperty(c, {
        landlordId, ownerUserId: userId, managedByUserId: userId,
      })
      await c.query('COMMIT')
      pmCompanyId = await seedPmCompany(landlordId)
      planId = await seedPmFeePlan(pmCompanyId)
      await db.query(
        `UPDATE properties SET pm_company_id=$1, pm_fee_plan_id=$2 WHERE id=$3`,
        [pmCompanyId, planId, propertyId])
    } finally { c.release() }
    const r = await getPmCompanyForProperty(propertyId)
    expect(r.source).toBe('property')
    expect(r.pm_company_id).toBe(pmCompanyId)
    expect(r.pm_fee_plan_id).toBe(planId)
  })

  it('only landlord default set → source=landlord_default + plan_id=null', async () => {
    const c = await db.connect()
    let propertyId = ''; let pmCompanyId = ''
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      propertyId = await seedProperty(c, {
        landlordId, ownerUserId: userId, managedByUserId: userId,
      })
      await c.query('COMMIT')
      pmCompanyId = await seedPmCompany(landlordId)
      await db.query(
        `UPDATE landlords SET default_pm_company_id=$1 WHERE id=$2`,
        [pmCompanyId, landlordId])
    } finally { c.release() }
    const r = await getPmCompanyForProperty(propertyId)
    expect(r.source).toBe('landlord_default')
    expect(r.pm_company_id).toBe(pmCompanyId)
    expect(r.pm_fee_plan_id).toBeNull()
  })

  it('property-level + landlord default both set → property wins', async () => {
    const c = await db.connect()
    let propertyId = ''; let propPm = ''; let defaultPm = ''
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      propertyId = await seedProperty(c, {
        landlordId, ownerUserId: userId, managedByUserId: userId,
      })
      await c.query('COMMIT')
      propPm = await seedPmCompany(landlordId)
      defaultPm = await seedPmCompany(landlordId)
      await db.query(
        `UPDATE landlords SET default_pm_company_id=$1 WHERE id=$2`,
        [defaultPm, landlordId])
      await db.query(
        `UPDATE properties SET pm_company_id=$1 WHERE id=$2`,
        [propPm, propertyId])
    } finally { c.release() }
    const r = await getPmCompanyForProperty(propertyId)
    expect(r.source).toBe('property')
    expect(r.pm_company_id).toBe(propPm)
    expect(r.pm_company_id).not.toBe(defaultPm)
  })

  it('neither set → source=null, both ids null', async () => {
    const c = await db.connect()
    let propertyId = ''
    try {
      await c.query('BEGIN')
      const { userId, landlordId } = await seedLandlord(c)
      propertyId = await seedProperty(c, {
        landlordId, ownerUserId: userId, managedByUserId: userId,
      })
      await c.query('COMMIT')
    } finally { c.release() }
    const r = await getPmCompanyForProperty(propertyId)
    expect(r.source).toBeNull()
    expect(r.pm_company_id).toBeNull()
    expect(r.pm_fee_plan_id).toBeNull()
  })

  it('unknown property → throws 404 AppError', async () => {
    await expect(getPmCompanyForProperty(
      '00000000-0000-0000-0000-000000000000'
    )).rejects.toMatchObject({ statusCode: 404 })
  })
})
