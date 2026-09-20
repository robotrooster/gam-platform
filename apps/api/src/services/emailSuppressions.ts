/**
 * S651 — the addresses GAM's mail provider has given up on.
 *
 * A bounce fires a webhook. A SUPPRESSION fires nothing, ever. Once Resend has
 * suppressed an address, every later send to it is accepted by the API, given a
 * message id, and thrown away — no delivered event, no bounced event, nothing
 * to contradict a send log that reads like success.
 *
 * That is how thirteen emails to Rashawn Bump vanished between 2026-08-29 and
 * 2026-09-19: invitations, reminders, and two lease signing requests, all
 * logged 'sent'. From the landlord's side a tenant was ignoring him for three
 * weeks. Nobody could have seen it from inside GAM, because GAM never asked the
 * provider what it already knew.
 *
 * So GAM mirrors the list and reads it before it sends. Two effects, both the
 * point:
 *   - a send to a dead address is recorded as 'undeliverable' rather than
 *     'sent', which is the difference between a log you can trust and one you
 *     cannot;
 *   - the landlord gets told, because they are the only person who can ask the
 *     tenant how their address is actually spelled.
 */
import { query, queryOne } from '../db'
import { logger } from '../lib/logger'

const API = 'https://api.resend.com/suppressions'

export interface SuppressionSyncResult {
  fetched: number
  added: number
  removed: number
  skipped?: string
}

/**
 * Pull the provider's suppression list and mirror it.
 *
 * Full replace rather than append: an address REMOVED at the provider (someone
 * cleaned it up, or the mailbox came back) has to stop being suppressed here
 * too, or GAM would refuse to mail somebody the provider is perfectly happy to
 * deliver to — a self-inflicted version of the very bug this fixes.
 */
export async function syncEmailSuppressions(
  fetchFn: typeof fetch = fetch,
): Promise<SuppressionSyncResult> {
  const key = process.env.RESEND_API_KEY
  if (!key) return { fetched: 0, added: 0, removed: 0, skipped: 'no RESEND_API_KEY' }

  const rows: { email: string; origin: string; id?: string; created_at?: string }[] = []
  let after: string | null = null
  // Paginate to the end. The list is small today and must not be assumed to
  // stay that way — a truncated read would silently un-suppress the tail.
  for (let page = 0; page < 50; page++) {
    const url = `${API}?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`
    const res = await fetchFn(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`Resend suppressions ${res.status}`)
    const body: any = await res.json()
    const data: any[] = body?.data ?? []
    rows.push(...data)
    if (!body?.has_more || !data.length) break
    after = data[data.length - 1]?.id ?? null
    if (!after) break
  }

  const emails = rows.map(r => String(r.email ?? '').trim().toLowerCase()).filter(Boolean)

  let added = 0
  for (const r of rows) {
    const email = String(r.email ?? '').trim().toLowerCase()
    if (!email) continue
    const ins = await query<{ email: string }>(
      `INSERT INTO email_suppressions (email, origin, provider_id, suppressed_at, last_synced_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (email) DO UPDATE
         SET origin = EXCLUDED.origin,
             provider_id = EXCLUDED.provider_id,
             suppressed_at = EXCLUDED.suppressed_at,
             last_synced_at = NOW()
       RETURNING (xmax = 0) AS email`,
      [email, String(r.origin ?? 'bounce'), r.id ?? null, r.created_at ?? null])
    if ((ins[0] as any)?.email === true) added++
  }

  const removed = await query<{ email: string }>(
    `DELETE FROM email_suppressions
      WHERE NOT (email = ANY($1::text[]))
      RETURNING email`, [emails])
  if (removed.length) {
    logger.info({ removed: removed.map(r => r.email) },
      '[email-suppressions] the provider no longer refuses these')
  }

  return { fetched: rows.length, added, removed: removed.length }
}

/**
 * Is this address one the provider will simply drop?
 *
 * Read on the send path, so it is one indexed primary-key probe and nothing
 * else. Returns null on any error: a lookup failure must never stop GAM
 * sending mail — the worst case of a false negative is the status quo.
 */
export async function suppressionFor(
  email: string,
): Promise<{ origin: string; suppressedAt: string | null } | null> {
  try {
    const row = await queryOne<{ origin: string; suppressed_at: string | null }>(
      `SELECT origin, suppressed_at::text FROM email_suppressions WHERE email = $1`,
      [email.trim().toLowerCase()])
    return row ? { origin: row.origin, suppressedAt: row.suppressed_at } : null
  } catch {
    return null
  }
}
