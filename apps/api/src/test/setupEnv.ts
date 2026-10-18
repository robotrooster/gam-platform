/**
 * S641 — per-file setup that no test can forget.
 *
 * Six "New landlord signup — Dusty Rhoades" alerts reached Nic's real inbox
 * from a full-suite run. One test file set EMAIL_SEND_LIVE=1 with no cleanup;
 * vitest shares a process across files, so the flag leaked, and a later test
 * that mailed a REAL address — the signup alert goes to the platform owner,
 * hardcoded — sent for real to Resend.
 *
 * Cleaning up inside the offending file fixes that file. This fixes the class:
 * the opt-in is cleared after every single test in every file, so a leak cannot
 * survive long enough to reach a suite that does not mock its mail client. A
 * file that wants live sending sets it in its own beforeEach, which still runs
 * after this hook and before the test.
 */
import { afterEach } from 'vitest'
import { WORKER_DB_POOL_MAX, templateDbName, workerCwd, workerDbName } from './testWorkers'

/**
 * 10/17 — EACH WORKER ON ITS OWN DATABASE AND ITS OWN FOLDER.
 *
 * This file runs BEFORE the test file is imported, which is the only moment
 * that works: db/index.ts reads DB_NAME once, when it is first imported, and
 * opens its pool on whatever it read. So the worker points itself at its own
 * copy here, by its vitest worker number — globalSetup.ts made one database per
 * worker, named for the same template (src/test/testWorkers.ts).
 *
 * Without a worker number there is nothing to point at (a pool vitest did not
 * number), and the run stays on the template exactly as it did when the whole
 * suite ran in one process.
 */
const poolId = Number(process.env.VITEST_POOL_ID)
if (Number.isInteger(poolId) && poolId >= 1) {
  const template = templateDbName()
  process.env.DB_NAME = workerDbName(template, poolId)
  // Held under the database's own connection cap (globalSetup), counting the
  // books' pool (db/ledgerPool.ts, 4) beside it, so a burst of parallel
  // requests inside one test waits for a connection rather than being refused.
  process.env.DB_POOL_MAX = String(WORKER_DB_POOL_MAX)
  // Uploads land under process.cwd()/uploads — see lib/fileServe.ts, which
  // reads cwd when it is imported. Working here keeps a test's files out of the
  // other workers' way and, more to the point, out of apps/api/uploads, which
  // is the folder the LIVE API serves real tenant documents from.
  process.chdir(workerCwd(template, poolId))
}

afterEach(() => {
  delete process.env.EMAIL_SEND_LIVE
})
