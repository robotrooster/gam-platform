/**
 * S654 — the monthly compliance archive failed on 2026-10-01: S605 added
 * provider_message_id / last_event / last_event_at to email_send_log and never
 * to email_send_log_archive, and the job copies every live column. It rolled
 * back (nothing lost), but the next added column would do the same, so the
 * live/archive pairing is held by a test instead of by the monthly run.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../db'
import { cleanupAllSchema } from '../test/dbHelpers'
import { processComplianceArchive, ARCHIVE_TARGETS } from './complianceArchive'

beforeEach(async () => { await cleanupAllSchema() })

async function logEmail(opts: {
  to: string; category: string; status: string; monthsAgo: number
  providerMessageId?: string; lastEvent?: string
}): Promise<string> {
  const { rows: [r] } = await db.query<{ id: string }>(
    `INSERT INTO email_send_log (to_email, subject, category, status,
                                 provider_message_id, last_event, last_event_at, created_at)
     VALUES ($1, 'Subject', $2, $3, $4, $5,
             CASE WHEN $5::text IS NULL THEN NULL ELSE NOW() - make_interval(months => $6) END,
             NOW() - make_interval(months => $6))
     RETURNING id`,
    [opts.to, opts.category, opts.status, opts.providerMessageId ?? null, opts.lastEvent ?? null, opts.monthsAgo])
  return r.id
}

const inLive = async (id: string) =>
  (await db.query(`SELECT 1 FROM email_send_log WHERE id = $1`, [id])).rows.length === 1

describe('compliance archive: email_send_log', () => {
  it('moves an old undeliverable row with its delivery events, keeps recent mail', async () => {
    const oldId = await logEmail({
      to: 'bounced@example.com', category: 'rent_receipt', status: 'undeliverable', monthsAgo: 25,
      providerMessageId: 're_msg_123', lastEvent: 'email.bounced',
    })
    const recentId = await logEmail({ to: 'recent@example.com', category: 'rent_receipt', status: 'sent', monthsAgo: 1 })

    const r = await processComplianceArchive()
    expect(r.errors).toEqual([])
    expect(r.stats.find(s => s.table === 'email_send_log')?.archived).toBe(1)

    expect(await inLive(oldId)).toBe(false)
    expect(await inLive(recentId)).toBe(true)
    const { rows: [a] } = await db.query<any>(
      `SELECT status, provider_message_id, last_event, last_event_at IS NOT NULL AS has_event_at,
              archived_at IS NOT NULL AS has_archived_at
         FROM email_send_log_archive WHERE id = $1`, [oldId])
    expect(a).toEqual({
      status: 'undeliverable', provider_message_id: 're_msg_123', last_event: 'email.bounced',
      has_event_at: true, has_archived_at: true,
    })
  })

  // S637 (Nic): "the log is the log." Correspondence cannot be deleted from the
  // live table (a trigger refuses), so the archive must leave it be — otherwise
  // one old letter would abort the whole table's archive every month.
  it('leaves correspondence in the live log and still archives machine mail', async () => {
    const letterId = await logEmail({ to: 'landlord@example.com', category: 'support_message', status: 'sent', monthsAgo: 30 })
    const receiptId = await logEmail({ to: 'tenant@example.com', category: 'rent_receipt', status: 'sent', monthsAgo: 30 })

    const r = await processComplianceArchive()
    expect(r.errors).toEqual([])
    expect(await inLive(letterId)).toBe(true)
    expect(await inLive(receiptId)).toBe(false)
    expect((await db.query(`SELECT 1 FROM email_send_log_archive WHERE id = $1`, [receiptId])).rows).toHaveLength(1)
  })
})

describe('compliance archive: every live column has a home in its archive', () => {
  type Col = { column_name: string; data_type: string; is_nullable: string; column_default: string | null }
  const columnsOf = async (table: string): Promise<Col[]> => (await db.query<Col>(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`, [table])).rows

  for (const { table } of ARCHIVE_TARGETS) {
    it(`${table} → ${table}_archive`, async () => {
      const live = await columnsOf(table)
      const archive = await columnsOf(`${table}_archive`)
      expect(live.length).toBeGreaterThan(0)
      expect(archive.length).toBeGreaterThan(0)

      // The job copies every live column by name; each must exist in the
      // archive with the same type.
      const archiveType = new Map(archive.map(c => [c.column_name, c.data_type]))
      const missing = live
        .filter(c => archiveType.get(c.column_name) !== c.data_type)
        .map(c => `${c.column_name} (${c.data_type}) → ${archiveType.get(c.column_name) ?? 'missing'}`)
      expect(missing).toEqual([])

      // Anything only the archive has must fill itself (archived_at, or a
      // column since dropped from the live table).
      const liveNames = new Set(live.map(c => c.column_name))
      const unfillable = archive
        .filter(c => !liveNames.has(c.column_name) && c.is_nullable === 'NO' && c.column_default == null)
        .map(c => c.column_name)
      expect(unfillable).toEqual([])

      // S654 (review): the 10/1 failure needed a CHECK change too ('undeliverable'
      // was allowed live but not in the archive). Every CHECK on the live table
      // must exist, word for word, on the archive; sizes must match as well.
      const checks = async (t: string) => (await db.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid = $1::regclass AND contype = 'c' ORDER BY 1`, [t])).rows.map(r => r.def)
      const archiveChecks = new Set(await checks(`${table}_archive`))
      expect((await checks(table)).filter(d => !archiveChecks.has(d))).toEqual([])
      const sizes = async (t: string) => new Map((await db.query<any>(
        `SELECT column_name, numeric_precision, numeric_scale, character_maximum_length
           FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [t]))
        .rows.map((c: any) => [c.column_name, `${c.numeric_precision}/${c.numeric_scale}/${c.character_maximum_length}`]))
      const liveSizes = await sizes(table), archiveSizes = await sizes(`${table}_archive`)
      expect([...liveSizes].filter(([n, v]) => archiveSizes.get(n) !== v).map(([n]) => n)).toEqual([])
    })
  }
})
