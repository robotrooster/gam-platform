/**
 * 10/12 (Nic) — GAM BOOKS LEDGER: THE TIE-OUT CHECK (CLI)
 *
 *   npm run ledger:check -- [--owner <landlord id>] [--no-repair]
 *
 * The same check the 04:40 nightly job runs (services/ledgerCheck): per
 * company, drain its waiting money records, check everything in one
 * REPEATABLE READ snapshot, record the findings in ledger_rebuild_runs, and
 * re-post drift from its source (unless --no-repair). Every company with
 * ledger activity when --owner is left out.
 */
import { db } from '../db'
import { ledgerDb } from '../db/ledgerPool'
import { registerProductionLedgerProjectors } from '../services/ledgerProjectors'
import { runLedgerChecks } from '../services/ledgerCheck'

function arg(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] ?? null : null
}

export async function main(): Promise<void> {
  registerProductionLedgerProjectors()
  const ownerId = arg('--owner')
  const results = await runLedgerChecks({
    owner: ownerId ? { landlordId: ownerId } : 'all',
    repair: !process.argv.includes('--no-repair'),
  })
  if (results.length === 0) console.log('No company has ledger activity to check.')
  for (const r of results) {
    const by = (s: string) => r.findings.filter(f => f.severity === s).length
    console.log(`${r.ownerId}  run ${r.runId}  integrity ${by('integrity')}  drift ${by('drift')}  pending ${by('pending')}  re-posted ${r.repaired}`)
    for (const f of r.findings.slice(0, 50)) console.log(`    [${f.severity}] ${f.check}  ${JSON.stringify(f.detail)}`)
  }
}

if (require.main === module) {
  main().then(async () => { await ledgerDb.end(); await db.end(); process.exit(0) })
    .catch(async (e) => { console.error(e instanceof Error ? e.message : e); await ledgerDb.end().catch(() => {}); await db.end().catch(() => {}); process.exit(1) })
}
