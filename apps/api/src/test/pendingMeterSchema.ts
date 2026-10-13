/**
 * 10/12 — utility_meters.zero_use_confirmed_at (and who confirmed it), for a
 * test database built before they reached schema.sql.
 *
 * gam_test is rebuilt from src/db/schema.sql on every run, and schema.sql only
 * changes when the migrations are applied to the live database and dumped
 * (`npm run migrate && npm run db:dump-schema`). Until then, suites that drive
 * the "meter confirmed working, nobody uses it" path (services/meterRepair,
 * scripts/oct12_gerald_meter) apply the migrations here, once, to the TEST
 * database only. The billing code reads the column through SELECT * and writes
 * it only when it is set, so every other suite runs without it. Once the
 * migration is applied and dumped this finds the column and does nothing —
 * then it can be deleted.
 */
import fs from 'fs'
import path from 'path'
import { db } from '../db'

// 10/12 (Nic, M1): the second adds who confirmed it ("Works, tenant uses no
// power"). Each is applied only while the column it adds is missing.
const FILES: Array<{ file: string; column: string }> = [
  { file: '20261013110000_utility_meter_zero_use_confirmed.sql', column: 'zero_use_confirmed_at' },
  { file: '20261013110100_utility_meter_zero_use_confirmed_by_and_moves.sql', column: 'zero_use_confirmed_by_user_id' },
]

export async function ensureMeterZeroUseSchema(): Promise<void> {
  const who = (await db.query<{ db: string }>(`SELECT current_database() AS db`)).rows[0]?.db ?? ''
  if (!who.endsWith('_test')) throw new Error(`ensureMeterZeroUseSchema REFUSED: connected to "${who}"`)
  for (const f of FILES) {
    const present = await db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'utility_meters' AND column_name = $1`, [f.column])
    if (present.rows.length) continue
    await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f.file), 'utf8'))
  }
}
