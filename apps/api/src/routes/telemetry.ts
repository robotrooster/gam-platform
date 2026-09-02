/**
 * S550 (Nic) — first-party product telemetry ingest. Portals batch
 * page-view/feature events here; rows land append-only in product_events.
 * Fire-and-forget by design: never errors loudly at the client, accepts
 * small batches, drops garbage silently. Auth optional — public pages
 * (marketing shells) may emit anonymously; authed requests stamp
 * user/role/landlord for cohort analysis.
 */
import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import { query } from '../db'

/** Parse the bearer token when present; anonymous otherwise. Never 401s —
 *  telemetry accepts unauthenticated events from public pages. */
function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    try { req.user = jwt.verify(header.slice(7), process.env.JWT_SECRET!) as any } catch { /* anonymous */ }
  }
  next()
}

export const telemetryRouter = Router()

const eventSchema = z.object({
  portal: z.string().min(1).max(30),
  event: z.string().min(1).max(60),
  path: z.string().max(300).optional(),
  meta: z.record(z.unknown()).optional(),
})
const batchSchema = z.object({ events: z.array(eventSchema).min(1).max(50) })

telemetryRouter.post('/telemetry/events', optionalAuth, async (req, res) => {
  try {
    const { events } = batchSchema.parse(req.body)
    const u = req.user
    const values: string[] = []
    const params: any[] = []
    for (const e of events) {
      const base = params.length
      params.push(e.portal, e.event, e.path ?? null,
        u?.userId ?? null, u?.role ?? null,
        // S633: telemetry stamps ONE landlord id for grouping. A landlord
        // session no longer names an entity, and picking one of several would
        // be a made-up attribution — team sessions still carry their single
        // landlordId, and a landlord's rows are attributable by user_id.
        u?.role === 'landlord' ? null : (u as any)?.landlordId ?? null,
        e.meta ? JSON.stringify(e.meta) : null)
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`)
    }
    await query(
      `INSERT INTO product_events (portal, event, path, user_id, role, landlord_id, meta)
       VALUES ${values.join(', ')}`,
      params,
    )
    res.json({ success: true })
  } catch {
    // Telemetry must never surface errors to the product experience.
    res.json({ success: true })
  }
})
