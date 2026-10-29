/**
 * 10/12 (Nic) — GAM BOOKS LEDGER: REBUILD FROM THE MONEY RECORDS (CLI)
 *
 *   npm run ledger:rebuild -- --owner <landlord id> | --all
 *                             [--source-type X] [--since YYYY-MM-DD]
 *                             --mode dry_run | apply | from_scratch
 *
 * See services/ledgerRebuild for what each mode does. dry_run writes nothing
 * to the ledger (it records the run and its drift). Refused for a company with
 * money and no books start date; from_scratch is refused once a month is
 * closed. Posts with the production projector set (services/ledgerProjectors).
 * Never run against production by an agent: Nic or the deploy runs it.
 */
import { LEDGER_SOURCE_TYPES, type LedgerSourceType } from '@gam/shared'
import { db } from '../db'
import { ledgerDb } from '../db/ledgerPool'
import { registerProductionLedgerProjectors } from '../services/ledgerProjectors'
import { rebuildLedger } from '../services/ledgerRebuild'

function arg(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] ?? null : null
}

export async function main(): Promise<void> {
  registerProductionLedgerProjectors()
  const ownerId = arg('--owner')
  const all = process.argv.includes('--all')
  const mode = arg('--mode')
  const sourceType = arg('--source-type')
  const since = arg('--since')
  if (!!ownerId === all) throw new Error('Pass --owner <landlord id> or --all.')
  if (mode !== 'dry_run' && mode !== 'apply' && mode !== 'from_scratch') throw new Error('Pass --mode dry_run | apply | from_scratch.')
  if (sourceType && !(LEDGER_SOURCE_TYPES as readonly string[]).includes(sourceType)) throw new Error(`Unknown source type ${sourceType}.`)
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error('--since is YYYY-MM-DD.')
  const results = await rebuildLedger({
    owner: all ? 'all' : { landlordId: ownerId! }, mode,
    sourceType: (sourceType as LedgerSourceType | null) ?? null, since: since ?? null,
  })
  if (results.length === 0) console.log('Nothing to rebuild (no company has a registered source).')
  for (const r of results) {
    console.log(`${r.ownerId}  ${r.status}${r.reason ? ` — ${r.reason}` : ''}  run ${r.runId}`)
    console.log(`  sources ${r.counts.sources}  posted ${r.counts.posted}  reversed ${r.counts.reversed}  unchanged ${r.counts.unchanged}  failed ${r.counts.failed}  drift ${r.counts.drift}`)
    for (const d of r.drift.slice(0, 50)) console.log(`    ${d.sourceType} ${d.sourceId}  ${d.status}${'message' in d && d.message ? `  ${d.message}` : ''}`)
  }
}

if (require.main === module) {
  main().then(async () => { await ledgerDb.end(); await db.end(); process.exit(0) })
    .catch(async (e) => { console.error(e instanceof Error ? e.message : e); await ledgerDb.end().catch(() => {}); await db.end().catch(() => {}); process.exit(1) })
}
