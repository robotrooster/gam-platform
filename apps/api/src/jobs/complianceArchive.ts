import { getClient } from '../db'
import { logger } from '../lib/logger'

// S133: Compliance/audit-log archival cron. Moves rows older than the
// cutoff out of the hot table into the `<table>_archive` sibling.
//
// Pattern: in a single transaction per table, INSERT INTO archive
// (SELECT … FROM hot WHERE created_at < cutoff RETURNING id), then
// DELETE FROM hot WHERE id IN (those ids). RETURNING + CTE keeps it
// atomic — a row never exists in zero places, never in two places.
//
// admin_notifications has an extra filter: only acknowledged rows
// archive. An unacked notification is by definition still actionable;
// archiving it would hide an active alert.
//
// email_send_log likewise skips correspondence (S654): a trigger refuses to
// delete any row email_log_is_permanent(category) names ("the log is the
// log", S637), so one such row past the cutoff would abort the whole table's
// archive every month. Same predicate the daily prune uses.

const CUTOFF_MONTHS = 24

interface ArchiveStats {
  table: string
  archived: number
}

async function archiveTable(table: string, extraWhere = ''): Promise<ArchiveStats> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const cutoffSql = `NOW() - INTERVAL '${CUTOFF_MONTHS} months'`
    const where = `created_at < ${cutoffSql}${extraWhere ? ' AND ' + extraWhere : ''}`

    // Pull source columns at runtime so the helper stays generic.
    // archived_at is the only column on the archive that isn't on the
    // hot table; it gets DEFAULT NOW() at insert.
    const cols = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = $1 AND table_schema = 'public'
          AND column_name <> 'archived_at'
        ORDER BY ordinal_position`,
      [table]
    )
    const colList = cols.rows.map(r => `"${r.column_name}"`).join(', ')

    const moved = await client.query<{ id: string }>(`
      WITH moved AS (
        DELETE FROM ${table}
         WHERE ${where}
         RETURNING ${colList}
      )
      INSERT INTO ${table}_archive (${colList})
      SELECT ${colList} FROM moved
      RETURNING id
    `)

    await client.query('COMMIT')
    return { table, archived: moved.rowCount ?? 0 }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error({ err: e, table }, '[compliance-archive] table archive failed')
    throw e
  } finally {
    client.release()
  }
}

// Exported so a test can hold every live table's columns against its archive
// (S654: three columns added to email_send_log alone broke the monthly run).
export const ARCHIVE_TARGETS: ReadonlyArray<{ table: string; extraWhere?: string }> = [
  { table: 'admin_action_log' },
  { table: 'audit_log' },
  { table: 'ach_monitoring_log' },
  { table: 'admin_notifications', extraWhere: 'acknowledged_at IS NOT NULL' },
  { table: 'email_send_log', extraWhere: 'NOT email_log_is_permanent(category)' },
]

export async function processComplianceArchive(): Promise<{ stats: ArchiveStats[]; errors: string[] }> {
  const stats: ArchiveStats[] = []
  const errors: string[] = []

  for (const t of ARCHIVE_TARGETS) {
    try {
      stats.push(await archiveTable(t.table, t.extraWhere))
    } catch (e) {
      errors.push(`${t.table}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return { stats, errors }
}
