import { Router } from 'express'
import { z } from 'zod'
import crypto from 'crypto'
import { query, queryOne, getClient } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { canAccessLandlordResource } from '../middleware/scope'
import { logger } from '../lib/logger'
import { replyToProperty } from '../services/replyRouting'
import { landlordScopeIds } from '../lib/landlordScope'
import { portalLink } from '../lib/portalUrls'
import { accountTiedElsewhere, NOT_A_RESIDENT_ACCOUNT } from '../jobs/leaseParser/resolveIntent'

const PLACEHOLDER_HASH = '$2b$10$placeholder_invite_pending'

/** S654: one fixed sentence for any account this door won't attach. It names
 *  nobody and says nothing about which company the person belongs to. */
const ALREADY_ON_GAM =
  'This person already has a GAM account. Ask them to add the service from their own portal.'

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
      // S654: every company the account holds (S633: a landlord session's
      // profileId names no company, so reading it returned an empty list to
      // every landlord). A team member's one company; nobody else's.
      const landlordIds = landlordScopeIds(req.user!)
      if (!landlordIds.length) return res.json({ success: true, data: [] })

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
               -- S654: still to be set up, not "holds a token": a resident with
               -- their own password is never sent a setup link from here, and a
               -- leftover token said nothing about whether they can sign in.
               (usr.password_hash = '$2b$10$placeholder_invite_pending'
                  AND usr.tenant_invite_accepted_at IS NULL) AS invite_pending,
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
         WHERE sa.landlord_id = ANY($1::uuid[])
         ORDER BY sa.status, p.name, u.unit_number
      `, [landlordIds])
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

      // The payer may already have an account. S614 is explicit that when their
      // space is later onboarded it must be the SAME person, same login, no
      // duplicate account. Reuse rather than collide, but only an account this
      // door may attach (S654, below).
      // S654: in any letter case (one login per address, ux_users_email_lower).
      // The exact-case match missed 'Mixed.X@Test.dev', and the INSERT below
      // then hit the unique index and returned a raw 500. A login that isn't a
      // resident's (landlord, staff, admin) is never a payer.
      const existingUser = await queryOne<{
        id: string; tenant_id: string | null; role: string; email: string; needs_setup: boolean
      }>(
        `SELECT u.id, t.id AS tenant_id, u.role, u.email,
                (u.password_hash = $2 AND u.tenant_invite_accepted_at IS NULL) AS needs_setup
           FROM users u LEFT JOIN tenants t ON t.user_id = u.id
          WHERE lower(u.email) = $1
          ORDER BY t.created_at NULLS LAST
          LIMIT 1`, [emailNorm, PLACEHOLDER_HASH])
      if (existingUser && existingUser.role !== 'tenant') {
        throw new AppError(409, NOT_A_RESIDENT_ACCOUNT)
      }

      // S654 (THE RULE): nobody attaches another company's person, or acts on
      // an account someone already holds, without that person's own consent
      // from their own session.
      //
      // Round 8, reproduced: any landlord typed a GAM resident's email here,
      // got 201 and alreadyOnPlatform (so the account exists), and the list
      // then showed that person's real first name, last name and phone. With
      // payerAlreadyAgreed the landlord could start billing them. And an
      // agreement on another company's never-set-up invitee tied that invitee
      // to this company, which then blocked the inviting company from
      // correcting its own invite.
      //
      // So this door attaches only an account it creates, or one that still
      // needs setup (placeholder password, invite never accepted) and is tied
      // to no other company. An account with its own password, or tied
      // elsewhere, is refused with one fixed sentence that names nobody, before
      // anything is written. Attaching such an account needs the payer's own
      // yes from their own session; the tenant portal has no flow for that
      // yet, so this door refuses rather than attach without it.
      if (existingUser && (!existingUser.needs_setup
        || await accountTiedElsewhere(existingUser.id, [landlordId, ...landlordScopeIds(req.user!)]))) {
        throw new AppError(409, ALREADY_ON_GAM)
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
           VALUES ($1, $5, 'tenant', $2, $3, $4)
           RETURNING id`,
          [emailNorm, body.payer.firstName, body.payer.lastName, body.payer.phone, PLACEHOLDER_HASH])
        userId = u.rows[0].id
      }
      // S654: a link only for the account just made or this company's own
      // still-to-be-set-up one (checked above). A live token is kept, not
      // replaced: the same company may already have emailed it (the "set up
      // and sign your lease" email from tenantLeaseLink), and minting a fresh
      // one killed that link. tenantLeaseLink reuses a live token for the same
      // reason. Whatever is stored is what gets mailed, so both emails work.
      const freshToken = crypto.randomBytes(32).toString('hex')
      const stored = await client.query<{ tenant_invite_token: string }>(
        `UPDATE users
            SET tenant_invite_token = CASE
                  WHEN tenant_invite_token IS NOT NULL AND tenant_invite_expires_at > NOW()
                  THEN tenant_invite_token ELSE $1 END,
                tenant_invite_expires_at = CASE
                  WHEN tenant_invite_token IS NOT NULL AND tenant_invite_expires_at > NOW()
                  THEN tenant_invite_expires_at ELSE NOW() + INTERVAL '7 days' END,
                updated_at = NOW()
          WHERE id = $2
            -- S654: still to be set up at the moment of writing, not only when
            -- checked above. If the person set their password in between,
            -- nothing is touched and the whole call is undone.
            AND password_hash = $3 AND tenant_invite_accepted_at IS NULL
          RETURNING tenant_invite_token`, [freshToken, userId, PLACEHOLDER_HASH])
      if (!stored.rows.length) throw new AppError(409, ALREADY_ON_GAM)
      const inviteToken = stored.rows[0].tenant_invite_token
      // S654: the address on the account is the only place a link goes.
      const accountEmail = existingUser?.email ?? emailNorm

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
      // S654: portalLink, never a localhost fallback (S641).
      try {
        const landlord = await queryOne<any>(
          `SELECT u.first_name, u.last_name FROM landlords l
             JOIN users u ON u.id = l.user_id WHERE l.id = $1`, [landlordId])
        const providerName = landlord ? `${landlord.first_name} ${landlord.last_name}`.trim() : 'Your utility provider'
        const { emailUtilityServiceInvite } = await import('../services/email')
        await emailUtilityServiceInvite(
          accountEmail, body.payer.firstName,
          providerName,
          body.serviceAddress || body.label,
          portalLink('tenant', `accept-invite?token=${inviteToken}`),
          // 10/5: replies reach the people who run this property (services/replyRouting).
          { landlordId, tenantId, replyTo: replyToProperty(property.id) })
      } catch (err) {
        // S654: never the link itself: it is a password-setting key.
        logger.error({ err, tenantId }, '[utility-service-invite] email failed — agreement created')
      }

      // S654: the response never carries a link.
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
  /** S616: attest after the fact — the neighbor never clicks emails, but the
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

/**
 * S616 (Nic) — the payer says they are moving out.
 *
 *   "Maybe that tenant portal profile that only has the utilities gets a big
 *    button that says 'hey, I need my final bill because I'm moving out', and
 *    then it's gonna look for more utilities to go onto a new person after that
 *    final billing period."
 *
 * Nobody is watching the neighbor's front door. The one person who reliably
 * knows they are leaving is the person leaving, so this is their button.
 *
 * It records a NOTICE, not a termination. The landlord confirms the final
 * reading and the handover — letting a payer end their own billing outright
 * would let somebody walk away from a balance by pressing a button.
 */
utilityServiceAgreementsRouter.post('/mine/moveout-notice', async (req, res, next) => {
  try {
    if (req.user!.role !== 'tenant') {
      throw new AppError(403, 'Only the payer can give notice on their own service.')
    }
    const body = z.object({
      expectedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      note:       z.string().trim().max(500).optional(),
    }).parse(req.body)

    // Their OWN live agreement. Scoped by the authenticated tenant rather than
    // an id from the body — a body-supplied agreement id would let one payer
    // give notice on another's service.
    const sa = await queryOne<any>(
      `SELECT sa.id, sa.landlord_id, sa.service_address, u.unit_number,
              usr.first_name, usr.last_name
         FROM utility_service_agreements sa
         JOIN units u    ON u.id = sa.unit_id
         JOIN tenants t  ON t.id = sa.tenant_id
         JOIN users usr  ON usr.id = t.user_id
        WHERE sa.tenant_id = $1 AND sa.status = 'active'
        LIMIT 1`, [req.user!.profileId])
    if (!sa) throw new AppError(404, 'You have no active utility service to give notice on.')

    const updated = await queryOne<any>(
      `UPDATE utility_service_agreements
          SET moveout_notice_at   = COALESCE(moveout_notice_at, NOW()),
              moveout_expected_on = $2::date,
              moveout_note        = COALESCE($3, moveout_note),
              updated_at          = NOW()
        WHERE id = $1
        RETURNING id, to_char(moveout_expected_on, 'YYYY-MM-DD') AS moveout_expected_on`,
      [sa.id, body.expectedOn, body.note ?? null])

    // The landlord is the one who has to act: read the meter, close the final
    // period, and find out who is taking over. Telling them is the entire point
    // — nobody else is watching that front door.
    try {
      const { createNotification } = await import('../services/notifications')
      const owner = await queryOne<{ user_id: string }>(
        `SELECT user_id FROM landlords WHERE id = $1`, [sa.landlord_id])
      if (owner) {
        await createNotification({
          userId: owner.user_id,
          landlordId: sa.landlord_id,
          type: 'service_moveout_notice',
          title: `${sa.first_name} ${sa.last_name} is leaving ${sa.service_address || sa.unit_number}`,
          body: `They have asked for a final utility bill, expecting to be gone by ${body.expectedOn}. Take a closing read around then, and set up whoever takes over so the meter does not keep billing the person who left.`,
          data: { serviceAgreementId: sa.id, expectedOn: body.expectedOn },
          actionUrl: '/utilities',
        })
      }
    } catch (err) {
      logger.error({ err, serviceAgreementId: sa.id },
        '[service-moveout] landlord notification failed — notice still recorded')
    }

    res.json({ success: true, data: updated })
  } catch (e) { next(e) }
})
