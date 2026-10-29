/**
 * 10/13 (Nic) — GAM Books ledger: the company-costs setting is retired; GAM's
 * own company-wide charges go to the Company column.
 *
 *   Nic, 10/13 (morning): "Company-level GAM charges before the owner picks:
 *   post to the COMPANY column by default." Nic, 10/13 (evening): "each
 *   expense is chosen on the split or specific unit or property at the time of
 *   logging. there should never be a default setting to apply expenses" — and
 *   "except gams charge all those costs get logged by a person".
 *
 * The Books settings no longer carry the choice (landlords.books_company_costs_
 * method and _from stay on the table, read by nothing); a GAM charge on no
 * property posts to the Company column whatever the old column says, through a
 * re-post and a rebuild from scratch; a cost a person logged goes where its
 * record says (ledgerCostPlace1013.test.ts), and one logged before 10/13 on no
 * property stays in the Company column. Real tables, real capture triggers,
 * the production projectors and checks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema, seedUnit } from '../test/dbHelpers'
import { ledgerCompany, inTx, type LedgerCompany } from '../test/ledgerFixtures'
import { drainLedgerOutbox } from './ledgerEngine'
import { registerProductionLedgerProjectors, unregisterProductionLedgerProjectors } from './ledgerProjectors'
import { checkOwner } from './ledgerCheck'
import { rebuildOwner } from './ledgerRebuild'
import { updateBooksSettings, getBooksSettings, type BooksViewer } from './booksSettings'

beforeEach(async () => {
  await cleanupAllSchema()
  registerProductionLedgerProjectors()
})
afterEach(() => unregisterProductionLedgerProjectors())

const owner = (co: LedgerCompany): BooksViewer => ({ landlordId: co.landlordId, userId: co.ownerUserId, kind: 'owner', canEdit: true, seesBank: true })

/** A GAM charge on no property (the bank cost of a pull — Oak Park's abe54e7a… is one). */
async function companyCharge(co: LedgerCompany, at?: string): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO landlord_gam_charges (landlord_id, property_id, kind, amount, source_type, created_at)
     VALUES ($1, NULL, 'bank_debit_cost', 6, 'gam_bank_debit_cost', COALESCE($2::timestamptz, now())) RETURNING id`,
    [co.landlordId, at ?? null])).rows[0].id
}

/** A source's active lines on a role, as [property, debit]. */
async function costLines(sourceType: string, sourceId: string, role: string): Promise<[string | null, number][]> {
  return (await db.query<{ property_id: string | null; dr: number }>(
    `SELECT l.property_id, l.debit::float AS dr FROM ledger_posting_lines l JOIN ledger_postings p ON p.id = l.posting_id
      WHERE p.source_type = $1 AND p.source_id = $2 AND p.role = 'post' AND p.superseded_at IS NULL AND l.account_role = $3
      ORDER BY l.property_id NULLS FIRST`, [sourceType, sourceId, role])).rows.map(r => [r.property_id, r.dr])
}

/** Three units on the first property, one on the second, all there since January. */
async function units(co: LedgerCompany): Promise<void> {
  await inTx(async c => {
    for (const [p, n] of [[co.propertyId, 2], [co.propertyId2, 1]] as const) {
      for (let i = 0; i < n; i++) await seedUnit(c, { propertyId: p, landlordId: co.landlordId })
    }
    await c.query(`UPDATE units SET created_at = '2026-01-01' WHERE landlord_id = $1`, [co.landlordId])
  })
}

/** The nightly check finds nothing wrong; a dry-run rebuild finds no drift; debits equal credits. */
async function clean(co: LedgerCompany): Promise<void> {
  const check = await checkOwner(co.owner)
  expect(check.findings.filter(f => f.severity === 'integrity' || f.severity === 'drift')).toEqual([])
  expect((await rebuildOwner(co.owner, { mode: 'dry_run' })).counts.drift).toBe(0)
  const b = (await db.query<{ dr: string; cr: string }>(
    `SELECT COALESCE(sum(debit), 0)::text AS dr, COALESCE(sum(credit), 0)::text AS cr FROM ledger_posting_lines WHERE landlord_id = $1`,
    [co.landlordId])).rows[0]
  expect(b.dr).toBe(b.cr)
}

describe('GAM\'s own company-wide charges: the Company column, no setting', () => {
  it('a GAM charge that was waiting on the owner (Oak Park\'s) posts to the Company column at the next retry', async () => {
    const co = await ledgerCompany()
    const id = await companyCharge(co, '2026-09-26 23:12:25+00')
    // As on production before 10/13: it failed with owner_not_ready and waits for its 15-minute retry.
    await db.query(
      `INSERT INTO ledger_source_errors (source_type, source_id, owner_id, reason_code, attempts, last_error, next_try_at)
       VALUES ('gam_charge', $1, $2, 'owner_not_ready', 28, 'Waiting on the owner: where company-level costs go …', now() + interval '15 minutes')`,
      [id, co.landlordId])
    await drainLedgerOutbox()
    expect(await costLines('gam_charge', id, 'bank_fees')).toEqual([])   // not yet: its retry is not due
    await db.query(`UPDATE ledger_source_errors SET next_try_at = now() WHERE source_type = 'gam_charge' AND source_id = $1`, [id])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await costLines('gam_charge', id, 'bank_fees')).toEqual([[null, 6]])
    expect((await db.query(`SELECT 1 FROM ledger_source_errors WHERE source_id = $1`, [id])).rows).toEqual([])
    // The settings carry no company-costs choice any more.
    expect(await getBooksSettings(owner(co))).not.toHaveProperty('companyCostsMethod')
    await clean(co)
  })
})

describe('the retired setting is read by nothing', () => {
  it('a charge stays in the Company column with the old "split by units" set — re-posted and rebuilt; the settings never save it', async () => {
    const co = await ledgerCompany()
    await units(co)
    const old = await companyCharge(co)
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await costLines('gam_charge', old, 'bank_fees')).toEqual([[null, 6]])

    // Sent the way the old page did: nothing saves (the settings route refuses it in words, booksSettings.test.ts).
    await updateBooksSettings({ viewer: owner(co), patch: { companyCostsMethod: 'split_by_units' } as any })
    expect((await db.query(`SELECT books_company_costs_method AS m, books_company_costs_from AS f FROM landlords WHERE id = $1`,
      [co.landlordId])).rows[0]).toEqual({ m: null, f: null })
    // Even set on the table, it decides nothing.
    await db.query(`UPDATE landlords SET books_company_costs_method = 'split_by_units', books_company_costs_from = '2026-01-01' WHERE id = $1`,
      [co.landlordId])
    await db.query(`UPDATE landlord_gam_charges SET amount = 6.5 WHERE id = $1`, [old])
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await costLines('gam_charge', old, 'bank_fees')).toEqual([[null, 6.5]])
    expect((await rebuildOwner(co.owner, { mode: 'from_scratch' })).counts.failed).toBe(0)
    expect(await costLines('gam_charge', old, 'bank_fees')).toEqual([[null, 6.5]])
    const fresh = await companyCharge(co)
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    expect(await costLines('gam_charge', fresh, 'bank_fees')).toEqual([[null, 6]])
    await clean(co)
  })

  it('an asset logged before 10/13 with no place stays in the Company column every month; one that said "split" splits every month', async () => {
    const co = await ledgerCompany()
    await units(co)
    await db.query(`UPDATE landlords SET books_company_costs_method = 'split_by_units', books_company_costs_from = '2026-03-15 18:00:00+00'
                     WHERE id = $1`, [co.landlordId])
    const [legacy, split] = await Promise.all(([null, 'split_by_units'] as const).map(async place => (await db.query<{ id: string }>(
      `INSERT INTO books_fixed_assets (landlord_id, property_id, cost_place, name, asset_class, cost, salvage_value, acquired_on, in_service_date,
                                       life_years, funded_by, created_at)
       VALUES ($1, NULL, $2, $3, 'vehicle', 4800, 0, '2026-02-01', '2026-02-01', 4, 'owner', '2026-02-01 18:00:00+00') RETURNING id`,
      [co.landlordId, place, place ? 'Office truck' : 'Old truck'])).rows[0].id))
    expect(await drainLedgerOutbox()).toMatchObject({ failed: 0 })
    for (const month of ['2026-02', '2026-03']) {
      expect(await costLines('fixed_asset', `${legacy}|${month}`, 'depreciation_expense')).toEqual([[null, 100]])
      expect((await costLines('fixed_asset', `${split}|${month}`, 'depreciation_expense')).sort())
        .toEqual([[co.propertyId, 75], [co.propertyId2, 25]].sort())
    }
    // Bought with the owner's own money: each truck's cost is on the books.
    expect(await costLines('fixed_asset', legacy, 'equipment')).toEqual([[null, 4800]])
    expect(await costLines('fixed_asset', split, 'equipment')).toEqual([[null, 4800]])
    await clean(co)
  })
})
