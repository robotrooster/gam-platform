/**
 * 10/12 (Nic) — GAM Books ledger, phase P8: fixtures for the report tests.
 *
 *   markRebuilt      records a finished full rebuild for a company (the test
 *                    has already posted what it needs with drain; a real
 *                    rebuild is covered by the engine's own tests)
 *   markLedgerLive   that, and a clean parity check after it — what switches
 *                    the company's reports onto the ledger
 *                    (services/ledgerReports ledgerReportsLive)
 */
import { db } from '../db'

async function testDbOnly(): Promise<void> {
  const who = await db.query<{ d: string }>(`SELECT current_database() AS d`)
  if (!String(who.rows[0]?.d ?? '').endsWith('_test')) throw new Error('ledger report fixtures refuse a non-test database')
}

export async function markRebuilt(landlordId: string): Promise<void> {
  await testDbOnly()
  await db.query(
    `INSERT INTO ledger_rebuild_runs (landlord_id, mode, status, scope, started_at, finished_at)
     VALUES ($1, 'from_scratch', 'done', '{"sourceType":null,"since":null}'::jsonb, now() - interval '2 minutes', now() - interval '1 minute')`,
    [landlordId])
}

export async function markLedgerLive(landlordId: string): Promise<void> {
  await markRebuilt(landlordId)
  await db.query(
    `INSERT INTO ledger_rebuild_runs (landlord_id, mode, status, scope, counts, finished_at)
     VALUES ($1, 'check', 'done', '{"kind":"parity"}'::jsonb, '{"differences":0,"unexplained":0}'::jsonb, now())`, [landlordId])
}
