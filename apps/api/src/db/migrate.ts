/**
 * GAM migration runner.
 *
 * Runs every file in apps/api/src/db/migrations/ that hasn't been applied yet,
 * in filename order (timestamps sort lexically). Each file runs in its own
 * transaction. On error, the file's transaction rolls back and the process
 * exits non-zero — pending files after the failure do not run.
 *
 * Tracking table: schema_migrations
 *   filename TEXT PRIMARY KEY
 *   applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
 *   checksum TEXT NOT NULL  -- sha256 of file contents at apply time
 *
 * If a migration's on-disk checksum doesn't match its tracked checksum,
 * the runner refuses to start. Edit history is forbidden — write a new
 * migration instead.
 *
 * Supported file types:
 *   .sql  — text is fed directly to the transaction's client.
 *   .ts   — must default-export `async (client: PoolClient) => void`.
 *           Runs inside the same transaction as the BEGIN/COMMIT wrapper.
 *
 * CLI:
 *   (no args)               run pending migrations
 *   --status                list every migration with state, exit non-zero if any checksum mismatch
 *   --mark-applied <file>   insert tracking row WITHOUT running the file
 *                           (one-time bootstrap on a DB that already has the schema)
 */

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { spawnSync } from 'child_process'
import { PoolClient } from 'pg'
import { db, getClient } from './index'

const MIGRATIONS_DIR = path.join(__dirname, 'migrations')

type MigrationStatus = 'pending' | 'applied' | 'mismatch'

interface MigrationFile {
  filename: string
  fullPath: string
  checksum: string
  ext: '.sql' | '.ts'
}

interface AppliedRow {
  filename: string
  checksum: string
  applied_at: Date
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function listMigrationFiles(): MigrationFile[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    fs.mkdirSync(MIGRATIONS_DIR, { recursive: true })
    return []
  }
  const entries = fs.readdirSync(MIGRATIONS_DIR)
  const files: MigrationFile[] = []
  for (const name of entries) {
    if (name.startsWith('.')) continue
    const ext = path.extname(name)
    if (ext !== '.sql' && ext !== '.ts') continue
    const fullPath = path.join(MIGRATIONS_DIR, name)
    const stat = fs.statSync(fullPath)
    if (!stat.isFile()) continue
    const contents = fs.readFileSync(fullPath, 'utf8')
    files.push({
      filename: name,
      fullPath,
      checksum: sha256(contents),
      ext: ext as '.sql' | '.ts',
    })
  }
  files.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0))
  return files
}

async function ensureTrackingTable(client: PoolClient): Promise<void> {
  // S291: schema-qualify every reference to schema_migrations. Some
  // migrations (notably the pg_dump-generated initial_schema.sql)
  // set `search_path = ''` inside their transaction. The runner's
  // post-migration INSERT then fails with "relation does not
  // exist" because the unqualified name can't resolve under an
  // empty search_path. Public-qualified references sidestep this.
  await client.query(`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      checksum   TEXT NOT NULL
    )
  `)
}

async function loadAppliedRows(client: PoolClient): Promise<Map<string, AppliedRow>> {
  const { rows } = await client.query<AppliedRow>(
    'SELECT filename, checksum, applied_at FROM public.schema_migrations'
  )
  return new Map(rows.map(r => [r.filename, r]))
}

function classify(file: MigrationFile, applied: Map<string, AppliedRow>): MigrationStatus {
  const row = applied.get(file.filename)
  if (!row) return 'pending'
  if (row.checksum !== file.checksum) return 'mismatch'
  return 'applied'
}

async function runSqlMigration(client: PoolClient, file: MigrationFile): Promise<void> {
  const sql = fs.readFileSync(file.fullPath, 'utf8')
  await client.query(sql)
}

async function runTsMigration(client: PoolClient, file: MigrationFile): Promise<void> {
  // ts-node compiles on require() for CommonJS, which the api uses.
  // The migration module must default-export an async function taking a PoolClient.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(file.fullPath)
  const fn = mod.default ?? mod
  if (typeof fn !== 'function') {
    throw new Error(
      `Migration ${file.filename}: expected default export to be an async function (client) => void`
    )
  }
  await fn(client)
}

async function applyMigration(file: MigrationFile): Promise<void> {
  const client = await getClient()
  try {
    // S291: the first migration is the pg_dump-generated
    // initial_schema.sql which contains
    //   SELECT pg_catalog.set_config('search_path', '', false)
    // The `false` flag makes that change session-scoped (not
    // transaction-scoped), so it persists across pool checkouts
    // and breaks every subsequent migration's unqualified table
    // references. Reset before each migration to public,pg_catalog.
    await client.query("SELECT pg_catalog.set_config('search_path', 'public, pg_catalog', false)")
    await client.query('BEGIN')
    if (file.ext === '.sql') {
      await runSqlMigration(client, file)
    } else {
      await runTsMigration(client, file)
    }
    // Belt-and-suspenders: re-reset inside the transaction in
    // case the migration body emptied it again.
    await client.query("SET LOCAL search_path TO public, pg_catalog")
    await client.query(
      'INSERT INTO public.schema_migrations (filename, checksum) VALUES ($1, $2)',
      [file.filename, file.checksum]
    )
    await client.query('COMMIT')
    console.log(`  ✓ applied  ${file.filename}`)
  } catch (err: any) {
    try { await client.query('ROLLBACK') } catch { /* swallow */ }
    console.error(`  ✗ failed   ${file.filename}`)
    console.error(`    ${err.message}`)
    throw err
  } finally {
    client.release()
  }
}

function regenerateSchemaSnapshot(): void {
  const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'dump-schema.sh')
  if (!fs.existsSync(scriptPath)) {
    console.warn(`  ⚠ schema dump script missing at ${scriptPath} — schema.sql not regenerated`)
    return
  }
  try {
    const result = spawnSync('bash', [scriptPath], { stdio: 'inherit' })
    if (result.status !== 0) {
      console.warn(`  ⚠ schema dump failed (exit ${result.status}) — schema.sql may be stale`)
    }
  } catch (err: any) {
    console.warn(`  ⚠ schema dump errored — schema.sql may be stale: ${err.message}`)
  }
}

async function cmdMigrate(): Promise<number> {
  const files = listMigrationFiles()
  if (files.length === 0) {
    console.log('No migration files found.')
    return 0
  }
  const setupClient = await getClient()
  let applied: Map<string, AppliedRow>
  try {
    await ensureTrackingTable(setupClient)
    applied = await loadAppliedRows(setupClient)
  } finally {
    setupClient.release()
  }

  const mismatches = files.filter(f => classify(f, applied) === 'mismatch')
  if (mismatches.length > 0) {
    console.error('REFUSING TO RUN — checksum mismatch on already-applied migration(s):')
    for (const m of mismatches) {
      const row = applied.get(m.filename)!
      console.error(`  ${m.filename}`)
      console.error(`    tracked checksum: ${row.checksum}`)
      console.error(`    on-disk checksum: ${m.checksum}`)
      console.error(`    applied at:       ${row.applied_at.toISOString()}`)
    }
    console.error('Do not edit applied migrations. Write a new migration that corrects the previous change.')
    return 2
  }

  const pending = files.filter(f => classify(f, applied) === 'pending')
  if (pending.length === 0) {
    console.log('All migrations applied. No pending work.')
    return 0
  }

  console.log(`Applying ${pending.length} pending migration(s)…`)
  for (const file of pending) {
    await applyMigration(file)
  }
  console.log(`✓ ${pending.length} migration(s) applied.`)
  regenerateSchemaSnapshot()
  return 0
}

async function cmdStatus(): Promise<number> {
  const files = listMigrationFiles()
  const setupClient = await getClient()
  let applied: Map<string, AppliedRow>
  try {
    await ensureTrackingTable(setupClient)
    applied = await loadAppliedRows(setupClient)
  } finally {
    setupClient.release()
  }
  if (files.length === 0) {
    console.log('No migration files on disk.')
  }
  let mismatchCount = 0
  for (const file of files) {
    const status = classify(file, applied)
    if (status === 'mismatch') mismatchCount++
    const tag = status === 'applied' ? 'APPLIED ' : status === 'pending' ? 'PENDING ' : 'MISMATCH'
    const ts = applied.get(file.filename)?.applied_at?.toISOString() ?? '-'
    console.log(`  ${tag}  ${file.filename.padEnd(60)} ${ts}`)
  }
  // List orphans: tracked rows whose file is missing from disk.
  const onDisk = new Set(files.map(f => f.filename))
  const orphans = [...applied.values()].filter(r => !onDisk.has(r.filename))
  for (const o of orphans) {
    console.log(`  ORPHAN    ${o.filename.padEnd(60)} ${o.applied_at.toISOString()}`)
  }
  return mismatchCount > 0 ? 2 : 0
}

async function cmdMarkApplied(filename: string): Promise<number> {
  const files = listMigrationFiles()
  const target = files.find(f => f.filename === filename)
  if (!target) {
    console.error(`File not found in migrations directory: ${filename}`)
    return 1
  }
  const client = await getClient()
  try {
    await ensureTrackingTable(client)
    await client.query(
      `INSERT INTO public.schema_migrations (filename, checksum) VALUES ($1, $2)
       ON CONFLICT (filename) DO NOTHING`,
      [target.filename, target.checksum]
    )
    console.log(`✓ marked applied (no file execution): ${target.filename}`)
    console.log(`  checksum: ${target.checksum}`)
    return 0
  } finally {
    client.release()
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let exitCode = 0
  try {
    if (args[0] === '--status') {
      exitCode = await cmdStatus()
    } else if (args[0] === '--mark-applied') {
      const filename = args[1]
      if (!filename) {
        console.error('Usage: migrate --mark-applied <filename>')
        exitCode = 1
      } else {
        exitCode = await cmdMarkApplied(filename)
      }
    } else if (args.length === 0) {
      exitCode = await cmdMigrate()
    } else {
      console.error(`Unknown args: ${args.join(' ')}`)
      console.error('Usage: migrate [--status | --mark-applied <filename>]')
      exitCode = 1
    }
  } catch (err: any) {
    console.error('Migration runner failed:', err.message)
    exitCode = 1
  } finally {
    await db.end()
  }
  process.exit(exitCode)
}

main()
