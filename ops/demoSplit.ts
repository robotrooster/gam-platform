/**
 * demoSplit — separate demo/seed data from real customer data.
 *
 * GAM's demo data isn't marked by a flag (landlords.is_demo exists but is wrong
 * on at least one demo landlord), so the boundary is drawn at the ACCOUNT and
 * everything reachable from it is pulled along by the foreign-key graph.
 *
 * Usage:
 *   ts-node demoSplit.ts --db gam      --delete demo   [--apply]
 *   ts-node demoSplit.ts --db gam_demo --delete real   [--apply]
 *
 * Without --apply it reports what it would delete and rolls back. The delete
 * always runs inside one transaction, so a closure that fails to converge
 * leaves the database untouched.
 */
import { Client } from 'pg'

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined }
const DB = arg('--db')
const SIDE = arg('--delete')          // 'demo' | 'real'
const APPLY = process.argv.includes('--apply')
if (!DB || !['demo', 'real'].includes(SIDE || '')) {
  console.error('usage: demoSplit.ts --db <name> --delete <demo|real> [--apply]'); process.exit(1)
}

// Synthetic domains. Every account on one of these was created by a seed
// script, never by a person signing up.
const DEMO_DOMAINS = ['demo.dev', 'tenant.dev', 'test.dev', 'business.dev', 'pmcompany.dev', 'example.com']
// Accounts that are infrastructure rather than data. They belong in BOTH
// databases and are never a deletion root on either side.
//   pool-intake@gam.internal — the renter-pool conduit landlord
//   admin@gam.dev            — the platform admin login
const SYSTEM_EMAILS = ['pool-intake@gam.internal', 'admin@gam.dev']

type FK = { child: string; childCol: string; parent: string; parentCol: string
            notNull: boolean; rule: string }

async function main() {
  const c = new Client({ database: DB, host: process.env.DB_HOST || 'localhost' })
  await c.connect()

  const { rows: allUsers } = await c.query<{ id: string; email: string }>(`SELECT id, email FROM users`)
  const isDemo = (e: string) => DEMO_DOMAINS.includes(e.split('@')[1] || '')
  const system = allUsers.filter(u => SYSTEM_EMAILS.includes(u.email))
  const demo = allUsers.filter(u => !SYSTEM_EMAILS.includes(u.email) && isDemo(u.email))
  const real = allUsers.filter(u => !SYSTEM_EMAILS.includes(u.email) && !isDemo(u.email))

  const roots = SIDE === 'demo' ? demo : real
  console.log(`db=${DB}  demo=${demo.length}  real=${real.length}  system(kept both)=${system.length}`)
  console.log(`deleting the ${SIDE} side: ${roots.length} root accounts\n`)
  if (roots.length === 0) { console.log('nothing to do'); await c.end(); return }

  // Full FK graph.
  const { rows: fks } = await c.query<FK>(`
    SELECT c.relname AS child, ac.attname AS "childCol",
           p.relname AS parent, ap.attname AS "parentCol",
           ac.attnotnull AS "notNull",
           CASE con.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
                                WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END AS rule
      FROM pg_constraint con
      JOIN pg_class c  ON c.oid  = con.conrelid
      JOIN pg_class p  ON p.oid  = con.confrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname='public'
      JOIN pg_attribute ac ON ac.attrelid = con.conrelid  AND ac.attnum = con.conkey[1]
      JOIN pg_attribute ap ON ap.attrelid = con.confrelid AND ap.attnum = con.confkey[1]
     WHERE con.contype = 'f' AND array_length(con.conkey,1) = 1`)

  // Tables we can address by a uuid `id` column. Join tables without one can't
  // seed the closure; their rows die with whichever parent goes first.
  const { rows: idTables } = await c.query<{ t: string }>(`
    SELECT c.relname AS t FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='id' AND NOT a.attisdropped
      JOIN pg_type ty ON ty.oid=a.atttypid AND ty.typname='uuid'
     WHERE c.relkind='r'`)
  const hasId = new Set(idTables.map(r => r.t))

  const byParent = new Map<string, FK[]>()
  for (const f of fks) { const l = byParent.get(f.parent) || []; l.push(f); byParent.set(f.parent, l) }

  await c.query('BEGIN')
  try {
    // Materialise the closure as temp tables of doomed ids, one per table.
    const doomed = new Map<string, Set<string>>()
    const add = (t: string, ids: string[]) => {
      const s = doomed.get(t) || new Set<string>()
      let added = 0
      for (const i of ids) if (!s.has(i)) { s.add(i); added++ }
      doomed.set(t, s); return added
    }
    add('users', roots.map(r => r.id))

    // Alternate two rules until the set stops growing:
    //   1. a NOT NULL reference to a doomed row cannot survive it → doomed
    //   2. a nullable reference gets cleared — unless clearing it violates a
    //      CHECK constraint (e.g. route_stops demands SOME customer ref), in
    //      which case that row can't survive either → doomed
    // A nullable reference must never be *followed*, or a demo landlord that
    // points at a real staff user would be dragged in with the real side.
    const nulledOut: string[] = []
    const forcedDelete: string[] = []
    for (let outer = 1; ; outer++) {
      let grew = 0
      for (let pass = 1; ; pass++) {
        let g = 0
        for (const [parent, ids] of [...doomed.entries()]) {
          for (const f of byParent.get(parent) || []) {
            if (!f.notNull || !hasId.has(f.child)) continue
            const { rows } = await c.query(
              `SELECT DISTINCT ch.id::text AS id FROM "${f.child}" ch
                WHERE ch."${f.childCol}" = ANY($1::uuid[])`, [[...ids]])
            if (rows.length) g += add(f.child, rows.map(r => r.id))
          }
        }
        if (!g) break
        grew += g
        if (pass > 50) throw new Error('closure did not converge')
      }
      let changed = 0
      for (const [parent, ids] of [...doomed.entries()]) {
        for (const f of byParent.get(parent) || []) {
          if (f.notNull || f.rule === 'CASCADE' || f.rule === 'SET NULL') continue
          const tag = `${f.child}.${f.childCol}`
          try {
            await c.query('SAVEPOINT n')
            const r = await c.query(`UPDATE "${f.child}" SET "${f.childCol}" = NULL
                                      WHERE "${f.childCol}" = ANY($1::uuid[])`, [[...ids]])
            await c.query('RELEASE SAVEPOINT n')
            if (r.rowCount && !nulledOut.includes(tag)) nulledOut.push(`${tag} (${r.rowCount})`)
          } catch {
            await c.query('ROLLBACK TO SAVEPOINT n')
            await c.query('RELEASE SAVEPOINT n')
            if (!hasId.has(f.child)) throw new Error(`cannot clear or delete ${tag}`)
            const { rows } = await c.query(
              `SELECT DISTINCT ch.id::text AS id FROM "${f.child}" ch
                WHERE ch."${f.childCol}" = ANY($1::uuid[])`, [[...ids]])
            const n = add(f.child, rows.map(r => r.id))
            if (n) { changed += n; if (!forcedDelete.includes(tag)) forcedDelete.push(`${tag} (${n})`) }
          }
        }
      }
      if (!changed && !grew) break
      if (outer > 20) throw new Error('null/doom alternation did not converge')
    }
    if (nulledOut.length)    console.log('cleared refs:  ' + nulledOut.join(', ') + '\n')
    if (forcedDelete.length) console.log('deleted (CHECK forbids a null ref): ' + forcedDelete.join(', ') + '\n')

    const summary = [...doomed.entries()].map(([t, s]) => [t, s.size] as const).sort((a, b) => b[1] - a[1])
    console.log('closure:')
    for (const [t, n] of summary) console.log(`  ${t.padEnd(42)} ${n}`)
    console.log(`  ${'TOTAL'.padEnd(42)} ${summary.reduce((a, b) => a + b[1], 0)}\n`)

    // Delete with retry: a table whose children aren't gone yet raises an FK
    // error, so loop until a whole pass makes no progress.
    let remaining = new Map(doomed)
    for (let pass = 1; remaining.size; pass++) {
      let progressed = false
      for (const [t, ids] of [...remaining.entries()]) {
        try {
          await c.query('SAVEPOINT d')
          await c.query(`DELETE FROM ${t} WHERE id = ANY($1::uuid[])`, [[...ids]])
          await c.query('RELEASE SAVEPOINT d')
          remaining.delete(t); progressed = true
        } catch { await c.query('ROLLBACK TO SAVEPOINT d') }
      }
      if (!progressed) {
        console.error('BLOCKED, could not delete:', [...remaining.keys()].join(', '))
        throw new Error('deletion blocked by foreign keys outside the closure')
      }
      if (pass > 60) throw new Error('delete did not converge')
    }

    if (APPLY) { await c.query('COMMIT'); console.log('COMMITTED') }
    else { await c.query('ROLLBACK'); console.log('DRY RUN — rolled back (pass --apply to commit)') }
  } catch (e) {
    await c.query('ROLLBACK'); console.error('ROLLED BACK:', (e as Error).message); process.exitCode = 1
  }
  await c.end()
}
main()
