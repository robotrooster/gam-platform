import { describe, it, expect, beforeAll } from 'vitest'
import { AGENT_PROFILES } from './profiles'
import { db } from '../../db'
import {
  cleanupAllSchema, seedLandlord, seedProperty, seedUnit, seedTenant, seedLease,
} from '../../test/dbHelpers'

let names: string[] = []
let properties: string[] = []
let units: string[] = []
let amounts: Set<string> = new Set()

/**
 * SEEDED, NOT READ FROM WHATEVER HAPPENS TO BE THERE.
 *
 * The first version queried the test database and found nothing — it is
 * schema-only — so every assertion passed against an empty set and the guard
 * was theatre. Exactly the failure requiredParams.test.ts had earlier the same
 * day, which is why the reach is now asserted before anything else.
 *
 * The seeded values are deliberately the SHAPE of the ones that leaked: a
 * person with a surname, a named property, a labelled unit, and a rent figure.
 */
beforeAll(async () => {
  await cleanupAllSchema()
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c, { firstName: 'Bob', lastName: 'Chen' })
    const propertyId = await seedProperty(c, {
      landlordId, ownerUserId: userId, managedByUserId: userId })
    await c.query(`UPDATE properties SET name = 'Sunset Palms' WHERE id = $1`, [propertyId])
    const unitId = await seedUnit(c, { propertyId, landlordId, rentAmount: 658 })
    await c.query(`UPDATE units SET unit_number = '101' WHERE id = $1`, [unitId])
    await seedTenant(c)
    await seedLease(c, { unitId, landlordId, rentAmount: 658, status: 'active' })
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }

  const people = await db.query<{ first_name: string; last_name: string }>(
    `SELECT first_name, last_name FROM users WHERE first_name IS NOT NULL LIMIT 500`)
  names = [...new Set(people.rows.flatMap((p) => [p.first_name, p.last_name])
    .filter((n) => n && n.length >= 3))]
  properties = (await db.query<{ name: string }>(`SELECT name FROM properties LIMIT 200`))
    .rows.map((p) => p.name).filter((n) => n && n.length >= 4)
  units = (await db.query<{ unit_number: string }>(`SELECT unit_number FROM units LIMIT 500`))
    .rows.map((u) => u.unit_number).filter(Boolean)
  const money = await db.query<{ amount: string }>(
    `SELECT DISTINCT rent_amount::text AS amount FROM leases WHERE rent_amount IS NOT NULL LIMIT 2000`)
  amounts = new Set(money.rows.map((m) => Math.round(Number(m.amount)).toLocaleString('en-US')))
})

const prompts = () => AGENT_PROFILES.map((p) => [p.id, p.systemPrompt] as const)

describe('system prompts quote nothing that exists', () => {
  it('is actually comparing against records — not passing on an empty set', () => {
    // The trap this suite could fall into is the one requiredParams already
    // fell into: a check that examined nothing and reported it clean. The test
    // database is schema-only, so if these lists come back empty every
    // assertion below passes vacuously and the guard is theatre.
    //
    // Seeded here rather than read from a live database, so the suite is
    // self-contained and the comparison set is never empty.
    expect(names.length + properties.length + units.length).toBeGreaterThan(0)
  })

  it('names no real person', () => {
    for (const [id, sp] of prompts()) {
      const found = names.filter((n) => new RegExp(`\\b${n}\\b`).test(sp))
      expect(found, `${id} names real people: ${found.join(', ')}`).toEqual([])
    }
  })

  it('names no real property', () => {
    for (const [id, sp] of prompts()) {
      const found = properties.filter((n) => sp.includes(n))
      expect(found, `${id} names real properties: ${found.join(', ')}`).toEqual([])
    }
  })

  it('quotes no real balance or rent figure', () => {
    // Any dollar amount in a prompt is a candidate for being read back as this
    // person's number. It only becomes dangerous when it MATCHES something —
    // then it is indistinguishable from a lookup, by the customer and by us.
    const real = amounts
    for (const [id, sp] of prompts()) {
      const quoted = [...new Set(sp.match(/\$[\d,]+/g) ?? [])].map((x) => x.slice(1))
      const collide = quoted.filter((q) => real.has(q))
      expect(collide, `${id} quotes real amounts: ${collide.join(', ')}`).toEqual([])
    }
  })

  it('does not quote a real unit number in a way that reads as a record', () => {
    // A bare "4" is not a leak; "Apt 101" alongside a name and a balance is.
    for (const [id, sp] of prompts()) {
      const labelled = [...new Set(sp.match(/\b(?:Apt|Unit|RV|Spot|Lot)\s+[A-Z0-9-]+/gi) ?? [])]
      const collide = labelled.filter((l) => {
        const n = l.split(/\s+/)[1].toUpperCase()
        return units.some((u) => String(u).toUpperCase() === n)
      })
      expect(collide, `${id} quotes real units: ${collide.join(', ')}`).toEqual([])
    }
  })
})
