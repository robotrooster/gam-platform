/**
 * 10/12 — the work-trade extra-hours schema, for a test database built before
 * it reached schema.sql.
 *
 * gam_test is rebuilt from src/db/schema.sql on every run, and schema.sql only
 * changes when the migrations are applied to the live database and dumped
 * (`npm run migrate && npm run db:dump-schema`). Until then, suites that drive
 * the extra-hours code apply the three migration files here, once, to the TEST
 * database only. Once the migrations are applied and dumped this finds every
 * piece already present and does nothing — then it can be deleted.
 */
import fs from 'fs'
import path from 'path'
import { db } from '../db'

const FILES: Array<{ file: string; present: string }> = [
  { file: '20261012180000_work_trade_extra_hours_setting.sql',
    present: `SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'work_trade_agreements' AND column_name = 'extra_hours_mode'` },
  { file: '20261012180100_work_trade_settlement_extra_hours_banked.sql',
    present: `SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'work_trade_settlements' AND column_name = 'extra_hours_banked'` },
  { file: '20261012180200_work_trade_extra_hours_payables.sql',
    present: `SELECT 1 WHERE to_regclass('public.work_trade_extra_hours') IS NOT NULL` },
]

export async function ensureWorkTradeExtraHoursSchema(): Promise<void> {
  const who = (await db.query<{ db: string }>(`SELECT current_database() AS db`)).rows[0]?.db ?? ''
  if (!who.endsWith('_test')) throw new Error(`ensureWorkTradeExtraHoursSchema REFUSED: connected to "${who}"`)
  for (const f of FILES) {
    if ((await db.query(f.present)).rows.length) continue
    await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', f.file), 'utf8'))
  }
}
