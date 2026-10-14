/**
 * 10/13 (Nic) — the birthdays already typed on signed leases, copied onto the
 * people they belong to. One time; signed leases from now on fill themselves
 * in when they finish signing (routes/esign.ts → services/leaseBirthdates).
 *
 * On 10/13 tenants.date_of_birth was empty for all 119 tenants while 82
 * birthdates had been typed into the lease form's "Birthdate 1/2/3" boxes.
 * Each is matched to the name beside it ("Tenant name 1/2/3") and to the
 * person by that name on that lease — never guessed. What does not match is
 * printed with the reason and left alone; a birthday already on a profile is
 * never changed. Running it again writes nothing new.
 *
 * DRY RUN BY DEFAULT — one READ ONLY transaction, so it can be pointed at
 * production: prints every typed birthdate, whose it is, and what would be
 * written. --apply writes them in one transaction.
 *   cd apps/api && npx ts-node -T src/scripts/oct13_lease_birthdates_backfill.ts
 *   cd apps/api && npx ts-node -T src/scripts/oct13_lease_birthdates_backfill.ts --apply
 */
import {
  copyLeaseBirthdates, BIRTHDATE_SKIP_REASON_LABEL, type BirthdateRun, type BirthdateSkipReason,
} from '../services/leaseBirthdates'

/** The run, in words: what was (or would be) written, and every birthdate left alone with its reason. */
export function formatRun(run: BirthdateRun): string {
  const out: string[] = []
  const verb = run.applied ? 'Written' : 'Would write'
  const writes = run.lines.filter(l => l.outcome === 'write')
  const onFile = run.lines.filter(l => l.outcome === 'already_on_file')
  const skipped = run.lines.filter(l => l.outcome === 'skipped')
  out.push(`${run.lines.length} birthdate${run.lines.length === 1 ? '' : 's'} typed on signed leases.`)
  out.push(`${verb}: ${run.tenantsWritten} tenant birthday${run.tenantsWritten === 1 ? '' : 's'}, `
    + `${run.occupantsWritten} occupant birthday${run.occupantsWritten === 1 ? '' : 's'}.`)
  out.push(`Already on file: ${onFile.length}. Left alone: ${skipped.length}.`)
  if (writes.length) {
    out.push('', `${verb}:`)
    for (const l of writes) {
      out.push(`  ${l.person!.name} (${l.person!.kind}) — ${l.birthday}   [${l.label} on document ${l.documentId}]`)
    }
  }
  if (skipped.length) {
    out.push('', 'Left alone:')
    const byReason = new Map<BirthdateSkipReason, typeof skipped>()
    for (const l of skipped) byReason.set(l.reason!, [...(byReason.get(l.reason!) ?? []), l])
    for (const [reason, lines] of byReason) {
      out.push(`  ${BIRTHDATE_SKIP_REASON_LABEL[reason]} (${lines.length}):`)
      for (const l of lines) {
        out.push(`    ${l.label} "${l.typed}" beside "${l.nameBeside ?? '—'}"${l.person ? ` → ${l.person.name}` : ''}`
          + `   [document ${l.documentId}]`)
      }
    }
  }
  return out.join('\n')
}

async function main() {
  const apply = process.argv.includes('--apply')
  const run = await copyLeaseBirthdates({ apply })
  console.log(formatRun(run))
  if (!apply) console.log('\nDry run — nothing was written. Run again with --apply to write.')
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
}
