/**
 * 10/17 (Nic) — WHAT THE MOVE TO ONE HOME DOES TO A COMPANY ALREADY RUNNING.
 *
 * The migration (20261019120000) has to carry what each company already set
 * into the one home without repricing anything — except the one thing it is
 * there to fix: a property whose own tax list already said a different rate
 * than the figure its stays were priced at. Mountain View, read 10/17: the
 * property column at 6.35%, the named "Lodging tax" at 6.6% ticked onto the
 * two site items, and a legacy 6.35% still sitting on those items.
 *
 * So this seeds exactly that shape and runs the migration over it, the way it
 * will run on production — and then runs it a SECOND time, because a migration
 * that mints a tax must never mint it twice.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { db } from '../db'
import { cleanupAllSchema, seedLandlord, seedProperty, seedUnit } from '../test/dbHelpers'

const MIGRATION = join(__dirname, '..', 'db', 'migrations', '20261019120000_one_home_for_a_tax_rate.sql')

beforeEach(async () => {
  await cleanupAllSchema()
})

/** Run the migration the way the runner does: the whole file, in one transaction. */
async function runMigration(): Promise<void> {
  const sql = readFileSync(MIGRATION, 'utf8')
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    await c.query(sql)
    await c.query('COMMIT')
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e } finally { c.release() }
}

interface Park { landlordId: string; propertyId: string; stayItemIds: string[]; goodsItemId: string }

/**
 * A company as production has it: the stay percentage left behind at 6.35%,
 * the named tax at 6.6% ticked onto the site items (which is how a lodging tax
 * used to be said), a transaction privilege tax on the propane, and the stale
 * 6.35% on the site items themselves.
 */
async function parkAsProductionHasIt(opts: { stayPct?: number; named?: number | null } = {}): Promise<Park> {
  const c = await db.connect()
  try {
    await c.query('BEGIN')
    const { userId, landlordId } = await seedLandlord(c)
    const propertyId = await seedProperty(c, { landlordId, ownerUserId: userId, managedByUserId: userId })
    await seedUnit(c, { propertyId, landlordId })
    await c.query(`UPDATE properties SET short_term_tax_rate = $2, nightly_rate = 100 WHERE id = $1`,
      [propertyId, opts.stayPct ?? 6.35])
    const catId = (await c.query<{ id: string }>(
      `INSERT INTO pos_categories (landlord_id, name, property_id) VALUES ($1, 'Sites', $2) RETURNING id`,
      [landlordId, propertyId])).rows[0].id
    const stayItemIds: string[] = []
    for (const [name, unit] of [['RV site — daily', 'night'], ['RV site — weekly', 'week']] as const) {
      stayItemIds.push((await c.query<{ id: string }>(
        `INSERT INTO pos_items (landlord_id, property_id, category_id, name, sell_price, tax_rate, stay_unit)
         VALUES ($1, $2, $3, $4, 100, 0.0635, $5) RETURNING id`,
        [landlordId, propertyId, catId, name, unit])).rows[0].id)
    }
    const goodsItemId = (await c.query<{ id: string }>(
      `INSERT INTO pos_items (landlord_id, property_id, category_id, name, sell_price, tax_rate)
       VALUES ($1, $2, $3, 'Propane', 3.30, 0) RETURNING id`,
      [landlordId, propertyId, catId])).rows[0].id
    if (opts.named !== null) {
      await c.query(
        `INSERT INTO pos_tax_rates (landlord_id, property_id, name, rate, tax_type, applies_to, item_ids)
         VALUES ($1, $2, 'Lodging tax', $3, 'sales', '{}'::text[], $4::uuid[])`,
        [landlordId, propertyId, (opts.named ?? 0.066), stayItemIds])
    }
    await c.query(
      `INSERT INTO pos_tax_rates (landlord_id, property_id, name, rate, tax_type, applies_to, item_ids)
       VALUES ($1, $2, 'Transaction privilege tax', 0.066, 'sales', '{}'::text[], $3::uuid[])`,
      [landlordId, propertyId, [goodsItemId]])
    await c.query('COMMIT')
    return { landlordId, propertyId, stayItemIds, goodsItemId }
  } catch (e) { await c.query('ROLLBACK'); throw e } finally { c.release() }
}

const stayPct = async (propertyId: string) => Number((await db.query<{ p: string }>(
  `SELECT short_term_tax_rate::text AS p FROM properties WHERE id = $1`, [propertyId])).rows[0].p)

const taxRows = async (landlordId: string) => (await db.query<any>(
  `SELECT name, rate::float AS rate, on_stays, item_ids FROM pos_tax_rates WHERE landlord_id = $1 ORDER BY name`,
  [landlordId])).rows

describe('the move to one home, over a company already running', () => {
  it('the three-week drift closes: the stay price moves to the rate the tax list already said', async () => {
    const park = await parkAsProductionHasIt()
    expect(await stayPct(park.propertyId)).toBe(6.35)

    await runMigration()

    // The named tax is the one home, and the stay percentage follows it.
    expect(await stayPct(park.propertyId)).toBe(6.60)
    const rows = await taxRows(park.landlordId)
    const lodging = rows.find(r => r.name === 'Lodging tax')
    expect(lodging.on_stays).toBe(true)
    expect(lodging.rate).toBe(0.066)
    // The item ticks were how the rate used to be said; the flag says it now.
    expect(lodging.item_ids).toEqual([])
    // A tax on goods is left exactly as it was.
    const tpt = rows.find(r => r.name === 'Transaction privilege tax')
    expect(tpt.on_stays).toBe(false)
    expect(tpt.item_ids).toEqual([park.goodsItemId])
    // And the stale third copy on the site items is gone.
    const stale = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pos_items WHERE landlord_id = $1 AND stay_unit IS NOT NULL AND tax_rate <> 0`,
      [park.landlordId])
    expect(stale.rows[0].n).toBe('0')
  })

  it('the change is on the record, as GAM\'s own, so a filing can see why the rate moved', async () => {
    const park = await parkAsProductionHasIt()
    await runMigration()
    // (The seeded taxes are journaled too here, because this database already
    // carries the trigger — on production the journal starts with the flip.)
    const j = await db.query<any>(
      `SELECT name, old_rate::float AS old_rate, new_rate::float AS new_rate, old_on_stays, new_on_stays, changed_by
         FROM pos_tax_rate_changes
        WHERE landlord_id = $1 AND old_on_stays IS FALSE AND new_on_stays IS TRUE
        ORDER BY id`, [park.landlordId])
    expect(j.rows).toHaveLength(1)
    expect(j.rows[0].name).toBe('Lodging tax')
    expect(j.rows[0].old_rate).toBe(0.066)   // the rate itself was not touched
    expect(j.rows[0].new_rate).toBe(0.066)
    expect(j.rows[0].changed_by).toBeNull()  // GAM's own move, not a person's
  })

  it('a property taxing stays with nothing named gets the tax named, at the rate it is already charging', async () => {
    // The demo park: 12% on the property, no named tax at all.
    const park = await parkAsProductionHasIt({ stayPct: 12, named: null })
    await runMigration()
    expect(await stayPct(park.propertyId)).toBe(12)
    const lodging = (await taxRows(park.landlordId)).find(r => r.name === 'Lodging tax')
    expect(lodging.rate).toBe(0.12)
    expect(lodging.on_stays).toBe(true)
  })

  it('a property that taxes no stay is left at nothing', async () => {
    const park = await parkAsProductionHasIt({ stayPct: 0, named: null })
    await runMigration()
    expect(await stayPct(park.propertyId)).toBe(0)
    expect((await taxRows(park.landlordId)).map(r => r.name)).toEqual(['Transaction privilege tax'])
  })

  it('running it twice changes nothing and mints no second tax', async () => {
    const park = await parkAsProductionHasIt({ stayPct: 12, named: null })
    await runMigration()
    const before = await taxRows(park.landlordId)
    const journalBefore = (await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pos_tax_rate_changes WHERE landlord_id = $1`, [park.landlordId])).rows[0].n

    await runMigration()

    expect(await taxRows(park.landlordId)).toEqual(before)
    expect(await stayPct(park.propertyId)).toBe(12)
    expect((await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pos_tax_rate_changes WHERE landlord_id = $1`, [park.landlordId])).rows[0].n)
      .toBe(journalBefore)
  })
})
