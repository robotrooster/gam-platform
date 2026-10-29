/**
 * 10/17 (Nic) — ONE DATABASE PER TEST WORKER, SO THE SUITE CAN RUN IN PARALLEL.
 *
 * Nic, 10/14: "these deploys are taking longer and longer they used to take 10
 * or 15 minutes and now they're taking 45 minutes." The API suite ran every
 * file one after another in a single process (737 files on 10/17), because
 * every file shared ONE test database: `beforeEach(cleanupAllSchema)` in one
 * file wipes the rows another file is mid-assertion on, so correctness forced
 * `singleFork` (apps/api/vitest.config.ts, and the long note in the repo-root
 * vitest.config.ts that says per-worker databases "would be the scalable fix").
 * This is that fix.
 *
 * Now the suite runs on several worker processes and each worker gets its OWN
 * database, cloned from the one globalSetup builds (schema.sql plus any
 * TEST_APPLY_MIGRATIONS_AFTER migrations), and its own working directory, so
 * the files a test writes under uploads/ are its worker's alone. A file only
 * ever shares a database with the files that ran before it on the same worker,
 * exactly as it did when there was one worker.
 *
 * Shared by vitest.config.ts (how many workers), globalSetup.ts (makes the
 * databases and folders) and setupEnv.ts (points each test file at its own).
 */
import os from 'os'
import path from 'path'

/**
 * How many files run at once. GAM_TEST_WORKERS sets it (deploy.sh passes its
 * own); 1 is the old one-process run.
 *
 * Bounded because the test databases live on the SAME Postgres as production
 * (max_connections 100, and the live API's pool alone may reach 20 plus the
 * books' 4): each worker is a process with its own connection pool, and
 * globalSetup caps every worker database at WORKER_DB_CONNECTION_LIMIT, so a
 * run can never hold more than workers x that limit. The default is what a
 * focused run by hand needs while another agent's suite is also going; the
 * ceiling keeps a typo from crowding the live API out of its own database.
 */
export const DEFAULT_TEST_WORKERS = 4
export const MAX_TEST_WORKERS = 8

export function testWorkerCount(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GAM_TEST_WORKERS
  if (raw === undefined || raw === '') return DEFAULT_TEST_WORKERS
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > MAX_TEST_WORKERS) {
    throw new Error(`GAM_TEST_WORKERS must be a whole number from 1 to ${MAX_TEST_WORKERS}, got '${raw}'`)
  }
  return n
}

/**
 * The most connections one worker's database accepts, and the API pool's share
 * of it. A worker runs one test file at a time and the tests inside a file one
 * at a time, so five is generous; the books keep their own small pool beside it
 * (db/ledgerPool.ts, 4 by default) and a test that opens a bare pg Client of
 * its own needs room too, which is what the three spare make.
 */
export const WORKER_DB_CONNECTION_LIMIT = 12
export const WORKER_DB_POOL_MAX = 5

const SUFFIX = '_test'
// The double underscore marks a worker clone, so a worker database can never be
// mistaken for another lane's own test database (gam_w1_test is a real one) and
// dropped as stale.
const WORKER_MARK = '__w'

/** The database every worker's copy is cloned from. */
export function templateDbName(env: NodeJS.ProcessEnv = process.env): string {
  return env.TEST_DB_NAME || 'gam_test'
}

/** gam_test → gam__w3_test. Ends in _test, so every *_test guard still holds. */
export function workerDbName(templateDb: string, workerId: number): string {
  if (!templateDb.endsWith(SUFFIX)) {
    throw new Error(`Refusing '${templateDb}' as a test database — name must end with '${SUFFIX}'`)
  }
  const name = `${templateDb.slice(0, -SUFFIX.length)}${WORKER_MARK}${workerId}${SUFFIX}`
  // Postgres silently cuts names at 63 bytes; two workers cut to one name would
  // share a database without anyone knowing.
  if (Buffer.byteLength(name) > 63) {
    throw new Error(`Worker database name '${name}' is longer than Postgres allows (63) — use a shorter TEST_DB_NAME`)
  }
  return name
}

/** Matches this template's worker clones (and nothing else), for dropping stale ones. */
export function isWorkerDbOf(templateDb: string, name: string): boolean {
  if (!templateDb.endsWith(SUFFIX)) return false
  const stem = templateDb.slice(0, -SUFFIX.length)
  if (!name.startsWith(stem + WORKER_MARK) || !name.endsWith(SUFFIX)) return false
  return /^\d+$/.test(name.slice(stem.length + WORKER_MARK.length, -SUFFIX.length))
}

/** The folder this run's workers work in (one subfolder each). */
export function workersRoot(templateDb: string): string {
  return path.join(os.tmpdir(), `gam-vitest-${templateDb}`)
}

/**
 * A worker's working directory. The API writes every upload under
 * process.cwd()/uploads, so a worker working here keeps its files apart from
 * the other workers' — and out of apps/api/uploads, which is the folder the
 * LIVE API (launchd, WorkingDirectory apps/api) serves real documents from.
 */
export function workerCwd(templateDb: string, workerId: number): string {
  return path.join(workersRoot(templateDb), `w${workerId}`)
}
