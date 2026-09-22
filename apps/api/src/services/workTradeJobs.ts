/**
 * S652 — MAINTENANCE JOBS FOR WORK TRADERS, IN THEIR TENANT PORTAL.
 *
 * Nic: "I want them to be self-starters... things that are intrinsically low
 * cost should just be visible to everybody and things that are potentially
 * expensive or skilled are assigned... any maintenance that picks up the words
 * electric or plumbing or water leak or power outage, those all scope to that
 * person." And: "trusted people can check off a job to make sure it was done
 * correctly."
 *
 * WHO SEES A JOB. A work trader with a LIVE agreement at the job's property sees:
 *   - every job assigned to them, and
 *   - unassigned open jobs the job's `work_trade_access` lets them see:
 *       auto   — general / landscape / cleaning / pest to everyone; a skilled
 *                category only to those holding that skill
 *       anyone — everyone;  none — nobody.
 * Requests are already sorted into categories from their words on the way in
 * (a water leak is plumbing), which is what makes the skill routing automatic.
 *
 * WHAT THEY SEE. The job, the unit and the notes about it — never the other
 * tenant's name, phone or email (audience isolation: a neighbour is not staff).
 *
 * DONE. A job is done when its taker says so, except a skilled job finished by
 * a MONITORED work trader: that waits for the landlord or a TRUSTED work trader
 * at the property to confirm it. Hours may be logged in the same step; they
 * follow the agreement's own rule (trusted counts now, monitored is Logged).
 */
import { query, queryOne } from '../db'
import { AppError } from '../middleware/errorHandler'
import { WORK_TRADE_OPEN_CATEGORIES } from '@gam/shared'

const OPEN = WORK_TRADE_OPEN_CATEGORIES as readonly string[]
const LIVE_JOB = `mr.status IN ('open','assigned','in_progress')`

export type Trader = {
  agreement_id: string; tenant_id: string; user_id: string; property_id: string
  landlord_id: string; trusted: boolean; skills: string[]; tracks_hours: boolean
}

/** The caller's live work-trade agreements (one per property they trade at). */
export async function tradersFor(userId: string): Promise<Trader[]> {
  return query<Trader>(
    `SELECT a.id AS agreement_id, a.tenant_id, t.user_id, un.property_id, a.landlord_id,
            a.trusted, a.skills, a.tracks_hours
       FROM work_trade_agreements a
       JOIN tenants t ON t.id = a.tenant_id
       JOIN units un ON un.id = a.unit_id
      WHERE t.user_id = $1 AND a.status = 'active'`, [userId])
}

/** Can this trader see this job right now? (the same rule the list uses) */
function visibleTo(job: any, tr: Trader): boolean {
  if (job.property_id !== tr.property_id) return false
  if (job.assigned_to === tr.user_id) return true
  if (job.assigned_to) return false
  if (job.work_trade_access === 'none') return false
  if (job.work_trade_access === 'anyone') return true
  const cat = job.category || 'general'
  return OPEN.includes(cat) || (tr.skills ?? []).includes(cat)
}

const JOB_COLUMNS = `
  mr.id, mr.title, mr.description, mr.category, mr.priority, mr.status, mr.created_at,
  mr.tenant_notes AS notes, mr.photos, mr.assigned_to, mr.work_trade_access,
  mr.needs_check, mr.done_by_user_id, mr.completed_at,
  un.unit_number, un.property_id, p.name AS property_name`

/** Jobs a work trader may see: theirs, the open ones, and skilled work that
 *  waits for a trusted person's check. Never another tenant's contact details. */
export async function jobsForTrader(userId: string) {
  const traders = await tradersFor(userId)
  if (!traders.length) return { available: [], mine: [], toCheck: [] }
  const props = [...new Set(traders.map(t => t.property_id))]
  const rows = await query<any>(
    `SELECT ${JOB_COLUMNS}
       FROM maintenance_requests mr
       JOIN units un ON un.id = mr.unit_id
       JOIN properties p ON p.id = un.property_id
      WHERE un.property_id = ANY($1::uuid[])
        AND (${LIVE_JOB} OR (mr.status = 'completed' AND mr.needs_check))
      ORDER BY CASE mr.priority WHEN 'emergency' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
               mr.created_at`, [props])
  const byProp = new Map(traders.map(t => [t.property_id, t]))
  const available: any[] = [], mine: any[] = [], toCheck: any[] = []
  for (const j of rows) {
    const tr = byProp.get(j.property_id)!
    if (j.status === 'completed') {
      if (tr.trusted && j.done_by_user_id !== userId) toCheck.push(j)
      continue
    }
    if (j.assigned_to === userId) mine.push(j)
    else if (visibleTo(j, tr)) available.push(j)
  }
  return { available, mine, toCheck }
}

async function loadJob(jobId: string) {
  const j = await queryOne<any>(
    `SELECT mr.*, un.property_id FROM maintenance_requests mr JOIN units un ON un.id = mr.unit_id WHERE mr.id = $1`, [jobId])
  if (!j) throw new AppError(404, 'Job not found')
  return j
}

async function traderAt(userId: string, propertyId: string): Promise<Trader> {
  const tr = (await tradersFor(userId)).find(t => t.property_id === propertyId)
  if (!tr) throw new AppError(403, 'You have no work trade agreement at this property')
  return tr
}

/** Take an open job. */
export async function takeJob(userId: string, jobId: string) {
  const job = await loadJob(jobId)
  const tr = await traderAt(userId, job.property_id)
  if (!['open', 'assigned', 'in_progress'].includes(job.status)) throw new AppError(409, 'That job is no longer open')
  if (!visibleTo(job, tr)) throw new AppError(403, 'That job is not open to you')
  if (job.assigned_to && job.assigned_to !== userId) throw new AppError(409, 'Someone else already took that job')
  // Only claim it if nobody has in the meantime.
  const row = await queryOne<any>(
    `UPDATE maintenance_requests SET assigned_to=$2, assigned_at=NOW(), status='in_progress', updated_at=NOW()
      WHERE id=$1 AND (assigned_to IS NULL OR assigned_to=$2) RETURNING id`, [jobId, userId])
  if (!row) throw new AppError(409, 'Someone else already took that job')
  await query(`INSERT INTO maintenance_comments (request_id, user_id, role, message, is_internal)
               VALUES ($1,$2,'maintenance','Taken by a work trader',TRUE)`, [jobId, userId])
  return { ok: true }
}

/** Mark a job done, optionally logging the hours it took in the same step. */
export async function finishJob(userId: string, jobId: string, opts: { hours?: number; note?: string }) {
  const job = await loadJob(jobId)
  const tr = await traderAt(userId, job.property_id)
  if (job.assigned_to !== userId) throw new AppError(403, 'Take the job before marking it done')
  if (!['assigned', 'in_progress', 'open'].includes(job.status)) throw new AppError(409, 'That job is not open')
  const skilled = !OPEN.includes(job.category || 'general') && job.work_trade_access !== 'anyone'
  const needsCheck = skilled && !tr.trusted
  await query(
    `UPDATE maintenance_requests SET status='completed', completed_at=NOW(), done_by_user_id=$2,
            needs_check=$3, updated_at=NOW(), man_hours=COALESCE($4, man_hours)
      WHERE id=$1`, [jobId, userId, needsCheck, opts.hours ?? null])
  const note = opts.note?.trim()
  await query(`INSERT INTO maintenance_comments (request_id, user_id, role, message, is_internal)
               VALUES ($1,$2,'maintenance',$3,FALSE)`,
    [jobId, userId, `Work completed${note ? ` — ${note}` : ''}${needsCheck ? ' (waiting for a check)' : ''}`])
  let log = null
  if (opts.hours && opts.hours > 0 && tr.tracks_hours !== false) {
    log = await queryOne<any>(
      `INSERT INTO work_trade_logs (agreement_id, tenant_id, submitted_by, work_date, hours, description, status, reviewed_at)
       VALUES ($1,$2,$3,CURRENT_DATE,$4,$5,$6,$7) RETURNING *`,
      [tr.agreement_id, tr.tenant_id, userId, opts.hours, `Job: ${job.title}${note ? ` — ${note}` : ''}`,
       tr.trusted ? 'approved' : 'pending', tr.trusted ? new Date() : null])
  }
  return { needsCheck, log }
}

/** Confirm a finished skilled job: the landlord's side, or a TRUSTED work trader
 *  at that property who did not do it themselves. */
export async function checkJob(user: { userId: string }, jobId: string, asLandlord: boolean) {
  const job = await loadJob(jobId)
  if (job.status !== 'completed' || !job.needs_check) throw new AppError(409, 'That job is not waiting for a check')
  if (!asLandlord) {
    const tr = await traderAt(user.userId, job.property_id)
    if (!tr.trusted) throw new AppError(403, 'Only a trusted work trader can confirm a job')
    if (job.done_by_user_id === user.userId) throw new AppError(403, 'Someone else confirms your own skilled job')
  }
  await query(`UPDATE maintenance_requests SET needs_check=false, checked_by=$2, checked_at=NOW(), updated_at=NOW() WHERE id=$1`,
    [jobId, user.userId])
  await query(`INSERT INTO maintenance_comments (request_id, user_id, role, message, is_internal)
               VALUES ($1,$2,$3,'Work checked and confirmed',FALSE)`,
    [jobId, user.userId, asLandlord ? 'landlord' : 'maintenance'])
  return { ok: true }
}

/**
 * An agreement that stops (ended, or asleep for the season) hands back any job
 * its person had taken, so nothing sits assigned to someone who is not there.
 * Finished jobs keep who did them.
 */
export async function releaseJobsFor(exec: { query: (sql: string, p: any[]) => Promise<any> }, agreementIds: string[]) {
  if (!agreementIds.length) return
  await exec.query(
    `UPDATE maintenance_requests mr SET assigned_to=NULL, assigned_at=NULL, status='open', updated_at=NOW()
      FROM work_trade_agreements a JOIN tenants t ON t.id = a.tenant_id
     WHERE a.id = ANY($1::uuid[]) AND mr.assigned_to = t.user_id
       AND mr.status IN ('assigned','in_progress')
       AND mr.landlord_id = a.landlord_id`, [agreementIds])
}

/** People a landlord may assign a job at this property to: their maintenance
 *  team and the property's live work traders. */
export async function assignableForProperty(propertyId: string) {
  return query<any>(
    `SELECT t.user_id, u.first_name, u.last_name, a.skills, a.trusted
       FROM work_trade_agreements a
       JOIN tenants t ON t.id = a.tenant_id
       JOIN users u ON u.id = t.user_id
       JOIN units un ON un.id = a.unit_id
      WHERE un.property_id = $1 AND a.status = 'active'
      ORDER BY u.first_name, u.last_name`, [propertyId])
}
