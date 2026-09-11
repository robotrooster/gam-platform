/**
 * S640 — the emergency contact list the front desk works from.
 *
 * Nic: "we wanna have a page that is accessible... near the front desk type
 * page or maybe a sub tab in the front desk page. That way my front desk help
 * Lisa Scheeler can see that, and have permission to edit and update fields
 * that are blank... when people come in to pay rent in person, Lisa can just
 * say, hey, just in case we ever need emergency contact information, who would
 * you like us to contact."
 *
 * Read and write both sit behind front_desk.view — the same single switch that
 * gives somebody the call list. Nic's rule for this role: "the less things that
 * it's possible for somebody to screw up, the bigger your talent pool is."
 * Property scope is applied server-side, exactly as the Front Desk page does,
 * so a desk person cannot see another park's residents whatever they type.
 */
import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requirePerm, getScopedPropertyIds } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { landlordScopeIds } from '../lib/landlordScope'
import {
  emergencyContactRoster, suggestPhoneForContact, importEmergencyContactsFromLeases,
} from '../services/emergencyContacts'
import { logger } from '../lib/logger'

export const emergencyContactsRouter = Router()
emergencyContactsRouter.use(requireAuth)

/** GET /api/emergency-contacts — the roster, with a suggestion where one exists. */
emergencyContactsRouter.get('/', requirePerm('front_desk.view', 'tenants.create'), async (req, res, next) => {
  try {
    const landlordIds = landlordScopeIds(req.user!)
    const rows = await emergencyContactRoster({
      landlordIds,
      propertyIds: await getScopedPropertyIds(req.user!),
    })

    // Only ask for a suggestion where one would help: a contact named, with no
    // number against it. One lookup pass, not one per row.
    const withSuggestions = await Promise.all(rows.map(async (r: any) => {
      if (r.contact_phone || !r.contact_name) return { ...r, suggestion: null }
      const s = await suggestPhoneForContact(r.contact_name, landlordIds).catch(() => null)
      return { ...r, suggestion: s }
    }))

    res.json({ success: true, data: withSuggestions })
  } catch (e) { next(e) }
})

const upsertSchema = z.object({
  tenantId:     z.string().uuid(),
  name:         z.string().trim().max(120).nullish(),
  phone:        z.string().trim().max(40).nullish(),
  relationship: z.string().trim().max(60).nullish(),
})

/**
 * PUT /api/emergency-contacts — record or correct one resident's contact.
 *
 * Deliberately an upsert on the tenant rather than an id-addressed edit: the
 * desk is answering "who do we call for this person", not editing a row they
 * looked up. One contact per resident is what a counter conversation produces.
 */
emergencyContactsRouter.put('/', requirePerm('front_desk.view', 'tenants.create'), async (req, res, next) => {
  try {
    const body = upsertSchema.parse(req.body)
    const landlordIds = landlordScopeIds(req.user!)
    const scoped = await getScopedPropertyIds(req.user!)

    // The tenant must be somebody this caller can actually see. A body-supplied
    // id is never trusted: unit numbers and names repeat across parks.
    const allowed = await queryOne<{ ok: boolean }>(
      `SELECT TRUE AS ok
         FROM lease_tenants lt
         JOIN leases l     ON l.id = lt.lease_id AND l.status = 'active'
         JOIN units un     ON un.id = l.unit_id
         JOIN properties p ON p.id = un.property_id
        WHERE lt.tenant_id = $1
          AND p.landlord_id = ANY($2::uuid[])
          AND ($3::uuid[] IS NULL OR p.id = ANY($3::uuid[]))
        LIMIT 1`,
      [body.tenantId, landlordIds, scoped],
    )
    if (!allowed) throw new AppError(404, 'Not found')

    const digits = (body.phone ?? '').replace(/\D/g, '')
    const phone = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
    if (phone && phone.length !== 10) {
      throw new AppError(400, 'That phone number needs to be 10 digits.')
    }
    const name = body.name?.trim() || null
    if (!name && !phone) {
      throw new AppError(400, 'Give a name or a phone number — a blank contact is not worth recording.')
    }

    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM emergency_contacts WHERE tenant_id = $1
        ORDER BY (phone IS NOT NULL) DESC, sort_order, created_at LIMIT 1`,
      [body.tenantId],
    )

    // Typed by a person, so it is confirmed by definition — that is what the
    // annual re-check is measuring against.
    const row = existing
      ? await queryOne<any>(
          `UPDATE emergency_contacts
              SET name = $2, phone = NULLIF($3, ''), relationship = $4,
                  source = 'staff', confirmed_at = NOW(), confirmed_by_user_id = $5,
                  updated_at = NOW()
            WHERE id = $1 RETURNING *`,
          [existing.id, name, phone, body.relationship?.trim() || null, req.user!.userId])
      : await queryOne<any>(
          `INSERT INTO emergency_contacts
             (tenant_id, name, phone, relationship, source, confirmed_at, confirmed_by_user_id, sort_order)
           VALUES ($1, $2, NULLIF($3, ''), $4, 'staff', NOW(), $5, 0) RETURNING *`,
          [body.tenantId, name, phone, body.relationship?.trim() || null, req.user!.userId])

    logger.info({ tenantId: body.tenantId, by: req.user!.userId },
      '[emergency-contacts] recorded at the desk')
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

/**
 * POST /api/emergency-contacts/confirm — "still current, nothing changed."
 *
 * The other half of the annual re-check. Confirming is not the same as editing
 * and must not require retyping what is already right.
 */
emergencyContactsRouter.post('/confirm', requirePerm('front_desk.view', 'tenants.create'), async (req, res, next) => {
  try {
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(req.body)
    const landlordIds = landlordScopeIds(req.user!)
    const scoped = await getScopedPropertyIds(req.user!)
    const updated = await query<{ id: string }>(
      `UPDATE emergency_contacts ec
          SET confirmed_at = NOW(), confirmed_by_user_id = $2, updated_at = NOW()
        FROM lease_tenants lt
        JOIN leases l     ON l.id = lt.lease_id AND l.status = 'active'
        JOIN units un     ON un.id = l.unit_id
        JOIN properties p ON p.id = un.property_id
       WHERE ec.tenant_id = lt.tenant_id
         AND lt.tenant_id = $1
         AND p.landlord_id = ANY($3::uuid[])
         AND ($4::uuid[] IS NULL OR p.id = ANY($4::uuid[]))
       RETURNING ec.id`,
      [tenantId, req.user!.userId, landlordIds, scoped])
    if (!updated.length) throw new AppError(404, 'Nothing on file to confirm')
    res.json({ success: true, data: { confirmed: updated.length } })
  } catch (e) { next(e) }
})

/**
 * POST /api/emergency-contacts/import — pull what the leases already carry.
 *
 * Owner-level: it writes across every resident at once, which is not a desk
 * action. Idempotent, so running it twice is safe.
 */
emergencyContactsRouter.post('/import', requirePerm('tenants.create'), async (req, res, next) => {
  try {
    const result = await importEmergencyContactsFromLeases({
      landlordIds: landlordScopeIds(req.user!),
    })
    res.json({ success: true, data: result })
  } catch (e) { next(e) }
})

// ── TENANT-FACING: MY OWN EMERGENCY CONTACT ────────────────────────────────
//
// Nic: "if there's no emergency contact on the leases, then we send the sort of
// survey in the tenant portal."
//
// The other end of the yearly check. A resident answering for themselves is the
// only version of this that is actually true — which is also why the agent is
// not allowed to answer it for them (see actionGap.ts).
emergencyContactsRouter.get('/mine', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenants only')
    const row = await queryOne<any>(
      `SELECT id, name, phone, relationship, confirmed_at
         FROM emergency_contacts
        WHERE tenant_id = (SELECT id FROM tenants WHERE user_id = $1)
        ORDER BY (phone IS NOT NULL) DESC, sort_order, created_at LIMIT 1`,
      [req.user!.userId])
    res.json({ success: true, data: row ?? null })
  } catch (e) { next(e) }
})

emergencyContactsRouter.put('/mine', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') throw new AppError(403, 'Tenants only')
    const body = z.object({
      name:         z.string().trim().max(120).nullish(),
      phone:        z.string().trim().max(40).nullish(),
      relationship: z.string().trim().max(60).nullish(),
    }).parse(req.body)

    const tenant = await queryOne<{ id: string }>(
      'SELECT id FROM tenants WHERE user_id = $1', [req.user!.userId])
    if (!tenant) throw new AppError(404, 'No tenant record')

    const digits = (body.phone ?? '').replace(/\D/g, '')
    const phone = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
    if (phone && phone.length !== 10) throw new AppError(400, 'That phone number needs to be 10 digits.')
    const name = body.name?.trim() || null
    if (!name && !phone) throw new AppError(400, 'Give a name and a phone number.')

    const existing = await queryOne<{ id: string }>(
      `SELECT id FROM emergency_contacts WHERE tenant_id = $1
        ORDER BY (phone IS NOT NULL) DESC, sort_order, created_at LIMIT 1`, [tenant.id])

    // Answered by the person themselves, so it is confirmed by definition.
    const row = existing
      ? await queryOne<any>(
          `UPDATE emergency_contacts
              SET name = $2, phone = NULLIF($3,''), relationship = $4,
                  source = 'tenant', confirmed_at = NOW(), confirmed_by_user_id = $5,
                  updated_at = NOW()
            WHERE id = $1 RETURNING id, name, phone, relationship, confirmed_at`,
          [existing.id, name, phone, body.relationship?.trim() || null, req.user!.userId])
      : await queryOne<any>(
          `INSERT INTO emergency_contacts
             (tenant_id, name, phone, relationship, source, confirmed_at, confirmed_by_user_id, sort_order)
           VALUES ($1,$2,NULLIF($3,''),$4,'tenant',NOW(),$5,0)
           RETURNING id, name, phone, relationship, confirmed_at`,
          [tenant.id, name, phone, body.relationship?.trim() || null, req.user!.userId])

    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})
