/**
 * 10/14 (Nic) — "storage units vs storage for rvs/boats etc": the accounts GAM
 * already set up under the old storage names get the plain ones. The dry run
 * writes nothing and names every account; --apply renames only GAM's own
 * accounts still carrying GAM's old name (a company's own name is left
 * alone); run again, nothing to do. Only the name changes.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { inTx, ledgerCompany } from '../test/ledgerFixtures'
import { cleanupTenantLedger } from '../test/ledgerTenantFixtures'
import { ensureChart, resolveAccount } from '../services/booksLedgerChart'
import { planStorageRenames, applyStorageRenames, describeStorageRenames } from './oct14_storage_account_names'

beforeEach(cleanupTenantLedger)

/** A company's chart, with its 4060 and its storage unit rent line as GAM named them before 10/14. */
async function oldChart(): Promise<{ landlordId: string; storage: string; unitLine: string }> {
  const co = await ledgerCompany()
  return inTx(async (c) => {
    const chart = await ensureChart(c, co.owner)
    const unitLine = (await resolveAccount(c, chart, { role: 'space_rent', sub: { kind: 'rent_line', value: 'storage' } }, '2026-10-01'))!.accountId
    const storage = (await resolveAccount(c, chart, { role: 'storage_fees' }, '2026-10-01'))!.accountId
    await c.query(`UPDATE books_accounts SET name = 'Storage' WHERE id = $1`, [storage])
    await c.query(`UPDATE books_accounts SET name = 'Storage space rent' WHERE id = $1`, [unitLine])
    return { landlordId: co.landlordId, storage, unitLine }
  })
}

const nameOf = async (id: string) => (await db.query<{ name: string }>(`SELECT name FROM books_accounts WHERE id = $1`, [id])).rows[0].name

describe('oct14_storage_account_names', () => {
  it('renames 4060 "Storage" to "RV and boat storage" and the storage unit line to "Storage unit rent"; the dry run writes nothing; run again, nothing to do', async () => {
    const a = await oldChart()
    const plan = await planStorageRenames(db)
    expect(plan.map(p => [p.accountId, p.code, p.from, p.to])).toEqual([
      [a.storage, '4060', 'Storage', 'RV and boat storage'],
      [a.unitLine, expect.stringMatching(/^4010-\d+$/), 'Storage space rent', 'Storage unit rent'],
    ])
    expect(describeStorageRenames(plan).join('\n')).toContain('"Storage" → "RV and boat storage"')
    expect(await nameOf(a.storage)).toBe('Storage')

    expect(await applyStorageRenames(db, plan)).toBe(2)
    expect(await nameOf(a.storage)).toBe('RV and boat storage')
    expect(await nameOf(a.unitLine)).toBe('Storage unit rent')
    expect(await planStorageRenames(db)).toEqual([])
  })

  it('leaves an account its company renamed itself, and one GAM did not set up', async () => {
    const a = await oldChart()
    await db.query(`UPDATE books_accounts SET name = 'Boat yard' WHERE id = $1`, [a.storage])
    await db.query(`UPDATE books_accounts SET is_system = FALSE WHERE id = $1`, [a.unitLine])
    expect(await planStorageRenames(db)).toEqual([])
    expect(await nameOf(a.storage)).toBe('Boat yard')
  })
})
