import { Router } from 'express'
import { z } from 'zod'
import crypto from 'crypto'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { canAccessLandlordResource } from '../middleware/scope'
import { logger } from '../lib/logger'

// ============================================================
// S615 — creating and managing a utility service agreement.
//
// S614 built the table and S615 built the invoice, and until this file there
// was still no way to make one exist. Nic could not bill the spaces next door
// because nothing could create the space, the payer, or the agreement.
//
// ONE CALL DOES ALL THREE, deliberately. A landlord adding the apartment next
// door is doing one thing, and splitting it across "add a unit" → "add a
// tenant" → "add an agreement" would ask him to create a UNIT that is not his
// and a TENANT with no tenancy before either makes sense. Worse, the middle
// step does not exist: the tenant onboarding flow demands a lease start and a
// monthly rent, neither of which is true here.
// ============================================================

export const utilityServiceAgreementsRouter = Router()
utilityServiceAgreementsRouter.use(requireAuth)

/** The landlord's own agreements, with the payer and what they currently owe. */
utilityServiceAgreementsRouter.get('/',
  requirePerm('properties.edit', 'units.edit', 'units.view_status'),
  async (req, res, next) => {
    try {
      const landlordId = req.user!.role === 'landlord'
        ? req.user!.profileId : req.user!.landlordId
      if (!landlordId) return res.json({ success: true, data: [] })

      const rows = await query<any>(`
        SELECT sa.id, sa.status, sa.service_address, sa.note,
               sa.billing_due_day,
               to_char(sa.start_date, 'YYYY-MM-DD') AS start_date,
               to_char(sa.end_date,   'YYYY-MM-DD') AS end_date,
               sa.superseded_by_lease_id,
               sa.unit_id, u.unit_number,
               p.id AS property_id, p.name AS property_name,
               sa.tenant_id,
               usr.first_name, usr.last_name, usr.email, usr.phone,
               -- Has the payer actually taken up their portal account? An
               -- outstanding invite is the difference between "they can pay
               -- online" and "you are still collecting cash".
               (usr.tenant_invite_token IS NOT NULL) AS invite_pending,
               -- S616: has this person agreed to be billed at all? Until they
               -- have, charges accrue but nothing is issued — and the landlord
               -- needs to see that rather than wonder why no bill went out.
               (sa.payer_accepted_at IS NOT NULL OR sa.payer_attested_at IS NOT NULL) AS payer_consented,
               sa.payer_accepted_at, sa.payer_attested_at,
               -- What they owe right now, across every invoice on this
               -- agreement. The reason the landlord opens this screen.
               COALESCE((
                 SELECT SUM(pay.amount)
                   FROM payments pay
                   JOIN invoices i ON i.id = pay.invoice_id
                  WHERE i.service_agreement_id = sa.id
                    AND pay.status IN ('pending','processing')
               ), 0)::text AS balance_due
          FROM utility_service_agreements sa
          JOIN units u      ON u.id = sa.unit_id
          JOIN properties p ON p.id = u.property_id
          JOIN tenants t    ON t.id = sa.tenant_id
          JOIN users usr    ON usr.id = t.user_id
         WHERE sa.landlord_id = $1
         ORDER BY sa.status, p.name, u.unit_number
      `, [landlordId])
      res.json({ success: true, data: rows })
    } catch (e) { next(e) }
  })

const createBody = z.object({
  propertyId:   z.string().uuid(),
  /** How the landlord refers to the space. Shows on the invoice. */
  label:        z.string().trim().min(1).max(40),
  serviceAddress: z.string().trim().max(200).optional(),
  note:         z.string().trim().max(500).optional(),
  billingDueDay: z.number().int().min(1).max(31).default(1),
  startDate:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** How many people live there — a RUBS pool split by headcount needs it. */
  householdSize: z.number().int().min(1).max(30).default(1),
  /** S616: the landlord states this person has already agreed to the
   *  arrangement — the cash-in-hand deal that predates GAM. Without it (or the
   *  payer accepting their invite) charges accrue but no invoice is issued. */
  payerAlreadyAgreed: z.boolean().optional(),
  payerAgreementNote: z.string().trim().max(300).optional(),
  payer: z.object({
    firstName: z.string().trim().min(1).max(60),
    lastName:  z.string().trim().min(1).max(60),
    email:     z.string().trim().email().max(200),
    phone:     z.string().trim().min(1).max(40),
  }),
})

utilityServiceAgreementsRouter.post('/', requirePerm('properties.edit'),
  async (req, res, next) => {
    const client = await getClient()
    try {
      const body = createBody.parse(req.body)
      const emailNorm = body.payer.email.toLowerCase()

      const property = await queryOne<any>(
        `SELECT id, landlord_id, name, street1, city, state, zip,
                late_fee_enabled, late_fee_grace_days,
                late_fee_initial_amount, late_fee_initial_type,
                late_fee_accrual_amount, late_fee_accrual_type,
                late_fee_accrual_period,
                late_fee_cap_amount, late_fee_cap_type
           FROM properties WHERE id = $1`, [body.propertyId])
      if (!property) throw new AppError(404, 'Property not found')
      if (!canAccessLandlordResource(req.user, property.landlord_id)) {
        throw new AppError(403, 'Forbidden')
      }
      const landlordId = property.landlord_id

      // The payer may already have an account — the neighbour could be an
      // existing tenant of this landlord, and S614 is explicit that when their
      // space is later onboarded it must be the SAME person, same login, no
      // duplicate account. Reuse rather than collide.
      const existingUser = await queryOne<any>(
        `SELECT u.id, t.id AS tenant_id, u.role
           FROM users u LEFT JOIN tenants t ON t.user_id = u.id
          WHERE u.email = $1`, [emailNorm])
      if (existingUser && existingUser.role !== 'tenant') {
        throw new AppError(409,
          'That email already belongs to a non-tenant account. Use a different address for the payer.')
      }

      await client.query('BEGIN')

      // 1. The space. A REAL unit (Nic: "it is technically a unit") so it can
      //    carry meter assignments, a trash-can quantity and a RUBS share like
      //    any other — marked utility_service so nothing treats it as rentable,
      //    listable or bookable. No rent: there is no tenancy to charge for.
      const unitRes = await client.query<{ id: string }>(
        `INSERT INTO units (property_id, landlord_id, unit_number, status,
                            rent_amount, security_deposit, bedrooms, bathrooms,
                            owner_household_size, is_bookable)
         VALUES ($1, $2, $3, 'utility_service', 0, 0, 0, 0, $4, false)
         RETURNING id`,
        [body.propertyId, landlordId, body.label, body.householdSize])
      const unitId = unitRes.rows[0].id

      // 2. The payer's account. Same shape the tenant invite flow uses — the
      //    whole point is that they get the tenant portal and pay their own
      //    bill instead of the landlord driving over for cash.
      let userId: string
      if (existingUser) {
        userId = existingUser.id
      } else {
        const u = await client.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
           VALUES ($1, '$2b$10$placeholder_invite_pending', 'tenant', $2, $3, $4)
           RETURNING id`,
          [emailNorm, body.payer.firstName, body.payer.lastName, body.payer.phone])
        userId = u.rows[0].id
      }
      const inviteToken = crypto.randomBytes(32).toString('hex')
      await client.query(
        `UPDATE users SET tenant_invite_token = $1,
                          tenant_invite_expires_at = NOW() + INTERVAL '7 days',
                          updated_at = NOW()
          WHERE id = $2`, [inviteToken, userId])

      let tenantId: string
      const existingTenant = await client.query<{ id: string }>(
        `SELECT id FROM tenants WHERE user_id = $1`, [userId])
      if (existingTenant.rows.length) {
        tenantId = existingTenant.rows[0].id
      } else {
        const t = await client.query<{ id: string }>(
          `INSERT INTO tenants (user_id, onboarding_source) VALUES ($1, 'onboarded')
           RETURNING id`, [userId])
        tenantId = t.rows[0].id
      }

      // 3. The agreement, with the property's late-fee policy STAMPED onto it.
      //    Read once, here, and never again — S558's rule that the instrument
      //    is the charge. A policy change next March must not silently reprice
      //    a bill this person already agreed to.
      const saRes = await client.query<{ id: string }>(
        `INSERT INTO utility_service_agreements (
           landlord_id, unit_id, tenant_id, service_address, note,
           billing_due_day, start_date, created_by,
           late_fee_enabled, late_fee_grace_days,
           late_fee_initial_amount, late_fee_initial_type,
           late_fee_accrual_amount, late_fee_accrual_type, late_fee_accrual_period,
           late_fee_cap_amount, late_fee_cap_type,
           payer_attested_at, payer_attested_by, payer_attestation_note
         ) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::date, CURRENT_DATE),$8,
                   $9,$10,$11,$12,$13,$14,$15,$16,$17,
                   CASE WHEN $18::boolean THEN NOW() ELSE NULL END,
                   CASE WHEN $18::boolean THEN $8::uuid ELSE NULL END,
                   $19)
         RETURNING id`,
        [landlordId, unitId, tenantId, body.serviceAddress ?? null,
         body.note ?? null, body.billingDueDay, body.startDate ?? null,
         req.user!.userId,
         property.late_fee_enabled, property.late_fee_grace_days,
         property.late_fee_initial_amount, property.late_fee_initial_type,
         property.late_fee_accrual_amount, property.late_fee_accrual_type,
         property.late_fee_accrual_period,
         property.late_fee_cap_amount, property.late_fee_cap_type,
         body.payerAlreadyAgreed ?? false, body.payerAgreementNote ?? null])

      await client.query('COMMIT')

      // Invite email, post-commit — a mail failure must not undo the agreement.
      const tenantAppUrl = process.env.TENANT_APP_URL || 'http://localhost:3002'
      const activationUrl = `${tenantAppUrl}/accept-invite?token=${inviteToken}`
      try {
        const { emailUtilityServiceInvite } = await import('../services/email')
        const landlord = await queryOne<any>(
          `SELECT u.first_name, u.last_name FROM landlords l
             JOIN users u ON u.id = l.user_id WHERE l.id = $1`, [landlordId])
        await emailUtilityServiceInvite(
          emailNorm, body.payer.firstName,
          landlord ? `${landlord.first_name} ${landlord.last_name}`.trim() : 'Your utility provider',
          body.serviceAddress || body.label,
          activationUrl,
          { landlordId, tenantId })
      } catch (err) {
        logger.error({ err, tenantId }, '[utility-service-invite] email failed — agreement created')
      }

      res.status(201).json({
        success: true,
        data: { id: saRes.rows[0].id, unitId, tenantId },
      })
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      next(e)
    } finally { client.release() }
  })

const patchBody = z.object({
  /** S616: attest after the fact — the neighbour never clicks emails, but the
   *  arrangement is real and the landlord is willing to say so on the record. */
  payerAlreadyAgreed: z.boolean().optional(),
  payerAgreementNote: z.string().trim().max(300).optional(),
  serviceAddress: z.string().trim().max(200).nullable().optional(),
  note:           z.string().trim().max(500).nullable().optional(),
  billingDueDay:  z.number().int().min(1).max(31).optional(),
  /** Ending it stops future invoices. Bills already issued stay owed — GAM
   *  never erases, and an unpaid balance does not vanish because the
   *  arrangement did. */
  status:         z.enum(['active', 'ended']).optional(),
  endDate:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
})

utilityServiceAgreementsRouter.patch('/:id', requirePerm('properties.edit'),
  async (req, res, next) => {
    try {
      const body = patchBody.parse(req.body)
      const sa = await queryOne<any>(
        `SELECT id, landlord_id, status FROM utility_service_agreements WHERE id = $1`,
        [req.params.id])
      if (!sa) throw new AppError(404, 'Service agreement not found')
      if (!canAccessLandlordResource(req.user, sa.landlord_id)) {
        throw new AppError(403, 'Forbidden')
      }

      // Ending it needs a date, or the billing window has no close and the
      // driver keeps cutting invoices for a space nobody is served at.
      const endingNow = body.status === 'ended' && sa.status !== 'ended'

      const updated = await queryOne<any>(
        `UPDATE utility_service_agreements
            SET payer_attested_at = CASE
                  WHEN $8::boolean AND payer_attested_at IS NULL THEN NOW()
                  ELSE payer_attested_at END,
                payer_attested_by = CASE
                  WHEN $8::boolean AND payer_attested_by IS NULL THEN $9::uuid
                  ELSE payer_attested_by END,
                payer_attestation_note = COALESCE($10, payer_attestation_note),
                service_address = COALESCE($2, service_address),
                note            = COALESCE($3, note),
                billing_due_day = COALESCE($4, billing_due_day),
                status          = COALESCE($5, status),
                end_date        = CASE
                                    WHEN $6::date IS NOT NULL THEN $6::date
                                    WHEN $7::boolean THEN CURRENT_DATE
                                    ELSE end_date
                                  END,
                updated_at      = NOW()
          WHERE id = $1
          RETURNING id, status, billing_due_day, service_address, note,
                    to_char(end_date, 'YYYY-MM-DD') AS end_date,
                    (payer_accepted_at IS NOT NULL OR payer_attested_at IS NOT NULL) AS payer_consented`,
        [req.params.id, body.serviceAddress ?? null, body.note ?? null,
         body.billingDueDay ?? null, body.status ?? null,
         body.endDate ?? null, endingNow,
         body.payerAlreadyAgreed ?? false, req.user!.userId,
         body.payerAgreementNote ?? null])

      res.json({ success: true, data: updated })
    } catch (e) { next(e) }
  })
