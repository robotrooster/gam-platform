// =====================================================================
// resolveIntent — turn a parsed/mismatch limbo intent into a real lease.
//
// Single caller path: POST /api/landlords/me/pending-tenants/:intentId/resolve
// with body { landlordOverrides: Partial<ParserOutput> }.
//
// CRITICAL: Never auto-callable. Every call point must come from a
// landlord click that hits the /resolve endpoint. parser_status='parsed'
// is "mostly green, landlord still confirms" — not a green light to
// build.
//
// Mirrors the /commit pattern from /onboard-tenants-csv: validate intent
// state -> merge ParserOutput + landlordOverrides -> re-run identity
// conflict checks -> INSERT lease -> set email_verify_token (deferred from
// limbo creation) -> INSERT lease_tenants -> write entity rows from
// ParserOutput -> promote PDF from pending dir to leases dir -> mark
// intent resolved -> fire activation email post-commit.
// =====================================================================

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import type { PoolClient } from 'pg'
import { getClient, queryOne } from '../../db'
import { emailTenantOnboarded } from '../../services/email'
import { AppError } from '../../middleware/errorHandler'
import { extractUploadFilename } from '../../lib/uploadPaths'
import type {
  ParserOutput, ParserExtractedField,
  ParserExtractedVehicle, ParserExtractedRv, ParserExtractedMobileHome,
  ParserExtractedPet, ParserExtractedOccupant,
  ParserExtractedIdentification, ParserExtractedEmergencyContact,
  ParserExtractedLiabilityInsurance,
} from '@gam/shared'
import { logger } from '../../lib/logger'

const pendingPdfDir = path.join(process.cwd(), 'uploads', 'lease-pdfs-pending')
const leasesPdfDir  = path.join(process.cwd(), 'uploads', 'leases')

if (!fs.existsSync(leasesPdfDir)) fs.mkdirSync(leasesPdfDir, { recursive: true })

interface IntentRow {
  id: string
  landlord_id: string
  tenant_id: string
  parser_status: string
  parser_output: ParserOutput | null
  imported_pdf_url: string | null
}

interface ResolveResult {
  leaseId: string
  tenantId: string
  userId: string
  email: string
  activationUrl: string
}

/**
 * Resolve a pending intent into a real lease. Throws AppError on any
 * validation failure -- caller endpoint surfaces these directly to the
 * landlord.
 *
 * Deep-merge semantics on overrides: landlordOverrides is a Partial
 * shaped like ParserOutput, layered ON TOP of intent.parser_output.
 * Per-field, the override wins. Field-level (not object-level) merge
 * because the landlord may correct only a single field while leaving
 * the rest of the parser's extraction.
 */
export async function resolveIntent(
  intentId: string,
  landlordId: string,
  landlordOverrides: Partial<ParserOutput>,
): Promise<ResolveResult> {
  const tenantAppUrl = process.env.TENANT_APP_URL || 'http://localhost:3002'

  // 1. Load intent + verify ownership + state
  const intent = await queryOne<IntentRow>(
    `SELECT id, landlord_id, tenant_id, parser_status, parser_output, imported_pdf_url
     FROM pending_tenant_intents
     WHERE id = $1 AND landlord_id = $2 AND resolved_at IS NULL`,
    [intentId, landlordId]
  )
  if (!intent) {
    throw new AppError(404, 'Pending tenant not found, already resolved, or not owned by you')
  }
  if (!['parsed', 'mismatch', 'error'].includes(intent.parser_status)) {
    throw new AppError(409, `Cannot resolve while parser_status='${intent.parser_status}'. Wait for parsing to finish.`)
  }
  if (!intent.parser_output && intent.parser_status !== 'error') {
    // 'error' may legitimately have no parser_output (parser threw before writing)
    // -- in that case landlordOverrides must supply EVERYTHING. 'parsed'/'mismatch'
    // without parser_output is a bug.
    throw new AppError(500, 'Intent is in inconsistent state: no parser_output but status is parsed/mismatch')
  }

  // 2. Merge parser_output + overrides. Override wins per field.
  const merged = mergeParserOutput(intent.parser_output, landlordOverrides)

  // Required fields after merge
  const tenant0 = merged.tenants[0]
  if (!tenant0?.firstName?.value || !tenant0?.lastName?.value || !tenant0?.email?.value) {
    throw new AppError(400, 'First name, last name, and email are required to build a lease')
  }
  if (!merged.unit?.unitNumber?.value || !merged.unit?.propertyName?.value) {
    throw new AppError(400, 'Unit number and property name are required to build a lease')
  }
  if (!merged.lease?.leaseStart?.value || !merged.lease?.monthlyRent?.value) {
    throw new AppError(400, 'Lease start and monthly rent are required to build a lease')
  }

  const emailNorm = String(tenant0.email.value).trim().toLowerCase()
  const firstName = String(tenant0.firstName.value).trim()
  const lastName  = String(tenant0.lastName.value).trim()
  const phone     = tenant0.phone?.value ? String(tenant0.phone.value).trim() : null

  // 3. Resolve unit_id from propertyName + unitNumber within this landlord's
  //    portfolio. Without a hit we can't build the lease.
  const unit = await queryOne<{ id: string; property_name: string; street1: string; city: string; state: string; zip: string; unit_number: string }>(
    `SELECT u.id, u.unit_number, p.name AS property_name, p.street1, p.city, p.state, p.zip
     FROM units u JOIN properties p ON p.id = u.property_id
     WHERE p.landlord_id = $1
       AND LOWER(p.name) = LOWER($2)
       AND LOWER(u.unit_number) = LOWER($3)
     LIMIT 1`,
    [landlordId, merged.unit.propertyName.value, merged.unit.unitNumber.value]
  )
  if (!unit) {
    throw new AppError(404, `Unit not found in your portfolio: ${merged.unit.propertyName.value} - ${merged.unit.unitNumber.value}`)
  }

  // 4. Cross-landlord active lease check (block).
  const userTenant = await queryOne<{ user_id: string; tenant_id: string }>(
    `SELECT u.id AS user_id, t.id AS tenant_id
     FROM users u
     LEFT JOIN tenants t ON t.user_id = u.id
     WHERE LOWER(u.email) = $1`,
    [emailNorm]
  )
  if (userTenant?.tenant_id) {
    const otherLease = await queryOne<{ landlord_id: string }>(
      `SELECT l.landlord_id FROM lease_tenants lt
       JOIN leases l ON l.id = lt.lease_id
       WHERE lt.tenant_id = $1 AND lt.status='active' AND l.status='active' AND l.landlord_id != $2
       LIMIT 1`,
      [userTenant.tenant_id, landlordId]
    )
    if (otherLease) {
      throw new AppError(409, 'This email is already a tenant of another landlord. Cross-landlord onboarding requires a separate flow.')
    }
  }

  // 5. Begin TX. Everything from here is rolled back on failure.
  const client = await getClient()
  let result: ResolveResult
  let oldLeaseToSupersede: string | null = null
  try {
    await client.query('BEGIN')

    // 5a. Same-landlord active lease on the SAME UNIT -- supersede it.
    //     If the landlord is re-onboarding the same unit (typical migration
    //     case where same unit has churn over years), close the prior lease
    //     and link via supersedes_lease_id.
    const priorOnUnit = await client.query(
      `SELECT id FROM leases
       WHERE unit_id = $1 AND landlord_id = $2 AND status = 'active'
       LIMIT 1`,
      [unit.id, landlordId]
    )
    if (priorOnUnit.rows.length > 0) {
      oldLeaseToSupersede = priorOnUnit.rows[0].id
    }

    // 5b. INSERT lease (mirrors /commit's INSERT shape)
    const lease = merged.lease
    const arBool = lease.autoRenew?.value === true
    const arMode = arBool ? (lease.autoRenewMode?.value || null) : null

    // S196: security_deposit removed from leases columns; written to
    // lease_fees via syncSecurityDepositLeaseFee below.
    const leaseInsert = await client.query(
      `INSERT INTO leases (
         unit_id, landlord_id, status, start_date, end_date, rent_amount,
         late_fee_initial_amount, late_fee_grace_days,
         lease_type, auto_renew, auto_renew_mode,
         notice_days_required, needs_review, lease_source,
         imported_pdf_url, supersedes_lease_id, extraction_extras,
         subleasing_allowed
       ) VALUES (
         $1, $2, 'active', $3, $4, $5,
         $6, $7,
         $8, $9, $10,
         $11, TRUE, 'imported',
         $12, $13, $14::jsonb,
         $15
       ) RETURNING id`,
      [
        unit.id, landlordId,
        lease.leaseStart.value, lease.leaseEnd?.value || null, lease.monthlyRent.value,
        lease.lateFeeAmount?.value ?? 15.00,
        lease.lateFeeGraceDays?.value ?? 5,
        lease.leaseType?.value || 'fixed_term',
        arBool, arMode,
        lease.noticeDaysRequired?.value ?? 30,
        intent.imported_pdf_url, // promoted later via rename; URL stays consistent
        oldLeaseToSupersede,
        merged.extractionExtras ? JSON.stringify(merged.extractionExtras) : null,
        lease.subleasingAllowed?.value || 'with_consent',
      ]
    )
    const leaseId = leaseInsert.rows[0].id

    // S195 dual-write: mirror security_deposit into lease_fees so the
    // catalog is consistent. Phase 2 will drop the legacy column.
    {
      const { syncSecurityDepositLeaseFee } = await import('../../services/leaseFeesSync')
      await syncSecurityDepositLeaseFee(leaseId, Number(lease.securityDeposit?.value ?? 0), client)
    }

    // 5c. Close the superseded lease if present
    if (oldLeaseToSupersede) {
      await client.query(
        `UPDATE leases SET status='ended', end_date=COALESCE(end_date, CURRENT_DATE), updated_at=NOW() WHERE id=$1`,
        [oldLeaseToSupersede]
      )
      await client.query(
        `UPDATE lease_tenants SET status='inactive', removed_at=NOW(), removed_reason='superseded' WHERE lease_id=$1 AND status='active'`,
        [oldLeaseToSupersede]
      )
    }

    // 5d. User row -- create or reuse
    let userId: string
    if (userTenant?.user_id) {
      userId = userTenant.user_id
      await client.query(
        `UPDATE users SET first_name=COALESCE(first_name, $1), last_name=COALESCE(last_name, $2), phone=COALESCE(phone, $3) WHERE id=$4`,
        [firstName, lastName, phone, userId]
      )
    } else {
      const tempHash = '$2b$10$placeholder_invite_pending'
      const u = await client.query(
        `INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
         VALUES ($1, $2, 'tenant', $3, $4, $5) RETURNING id`,
        [emailNorm, tempHash, firstName, lastName, phone]
      )
      userId = u.rows[0].id
    }

    // 5e. Activation token -- finally fires now (deferred from limbo creation)
    // S410 (S377): tenant_invite_token + 7-day expiry. Pre-S410 wrote to
    // overloaded email_verify_token.
    const inviteToken = crypto.randomBytes(32).toString('hex')
    await client.query(
      `UPDATE users SET tenant_invite_token=$1,
                        tenant_invite_expires_at=NOW() + INTERVAL '7 days'
        WHERE id=$2`,
      [inviteToken, userId])

    // 5f. Tenant row -- create or reuse, promote to onboarded
    let tenantIdMaybe: string | undefined = userTenant?.tenant_id
    if (tenantIdMaybe) {
      await client.query(
        `UPDATE tenants SET onboarding_source='onboarded' WHERE id=$1 AND onboarding_source != 'onboarded'`,
        [tenantIdMaybe]
      )
    } else {
      const t = await client.query(
        `INSERT INTO tenants (user_id, onboarding_source) VALUES ($1, 'onboarded') RETURNING id`,
        [userId]
      )
      tenantIdMaybe = t.rows[0].id
    }
    const tenantId: string = tenantIdMaybe!

    // Tenant-only fields beyond user identity
    if (tenant0.dateOfBirth?.value) {
      await client.query(
        `UPDATE tenants SET date_of_birth=COALESCE(date_of_birth, $1) WHERE id=$2`,
        [tenant0.dateOfBirth.value, tenantId]
      )
    }
    if (tenant0.mailingAddress?.value) {
      await client.query(
        `UPDATE tenants SET mailing_address=COALESCE(mailing_address, $1) WHERE id=$2`,
        [tenant0.mailingAddress.value, tenantId]
      )
    }

    // 5g. lease_tenants
    await client.query(
      `INSERT INTO lease_tenants (lease_id, tenant_id, role, status, added_at, added_reason, financial_responsibility)
       VALUES ($1, $2, 'primary', 'active', NOW(), 'original', 'joint_several')`,
      [leaseId, tenantId]
    )

    // 5h. Entity rows from ParserOutput
    await writeEntityRows(client, leaseId, tenantId, unit.id, merged)

    // 5i. Mark intent resolved
    await client.query(
      `UPDATE pending_tenant_intents
       SET parser_status='resolved', resolved_at=NOW(), resolved_lease_id=$1, updated_at=NOW()
       WHERE id=$2`,
      [leaseId, intentId]
    )

    await client.query('COMMIT')

    // 6. Promote PDF from pending dir -> leases dir (post-commit because
    //    rolling back a rename is messier than rolling back a DB write).
    if (intent.imported_pdf_url) {
      try {
        const filename = extractUploadFilename(intent.imported_pdf_url)
        if (filename) {
          const fromPath = path.join(pendingPdfDir, filename)
          const toPath = path.join(leasesPdfDir, filename)
          if (fs.existsSync(fromPath)) fs.renameSync(fromPath, toPath)
        }
      } catch (e) {
        // Non-fatal: the lease is real, the PDF reference may be broken
        // until a manual fix. Logged for ops review.
        logger.error({ err: e, ctx: leaseId }, '[RESOLVE] PDF promotion failed for lease')
      }
    }

    const propertyAddress = [unit.street1, unit.city, unit.state, unit.zip].filter(Boolean).join(', ')
    const unitLabel = `${unit.property_name} - Unit ${unit.unit_number}`
    const activationUrl = `${tenantAppUrl}/accept-invite?token=${inviteToken}`

    result = { leaseId, tenantId, userId, email: emailNorm, activationUrl }

    // 7. Send activation email (post-commit; failure logged but does not roll back)
    try {
      const landlord = await queryOne<{ first_name: string; last_name: string }>(
        `SELECT u.first_name, u.last_name FROM landlords l JOIN users u ON u.id = l.user_id WHERE l.id = $1`,
        [landlordId]
      )
      const landlordName = landlord ? `${landlord.first_name} ${landlord.last_name}`.trim() : 'Your landlord'
      await emailTenantOnboarded(
        emailNorm, firstName, landlordName, propertyAddress, unitLabel, activationUrl,
        { landlordId, tenantId }
      )
    } catch (emailErr) {
      logger.error({ err: emailErr, ctx: emailNorm }, '[RESOLVE] Email send failed for')
      logger.info(`[RESOLVE] Manual activation URL for ${emailNorm}: ${activationUrl}`)
    }

    return result
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// ---------------------------------------------------------------------
// Entity-row fan-out -- writes lease-attached entity rows from ParserOutput.
// All optional sections; only writes what's present.
// ---------------------------------------------------------------------
async function writeEntityRows(
  client: PoolClient,
  leaseId: string,
  tenantId: string,
  unitId: string,
  out: ParserOutput,
): Promise<void> {
  const t0 = out.tenants[0]

  // Identifications -- multiple per tenant, first marked is_primary
  if (t0?.identifications && t0.identifications.length > 0) {
    for (let i = 0; i < t0.identifications.length; i++) {
      const id = t0.identifications[i]
      await client.query(
        `INSERT INTO tenant_identifications (
           tenant_id, id_type, id_number, issuing_state, issuing_country, expiry_date, is_primary
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          tenantId,
          id.idType.value,
          id.idNumber.value,
          id.issuingState?.value || null,
          id.issuingCountry?.value || 'US',
          id.expiryDate?.value || null,
          i === 0,
        ]
      )
    }
  }

  // Emergency contacts -- multiple per tenant, sort_order preserves order
  if (t0?.emergencyContacts && t0.emergencyContacts.length > 0) {
    for (let i = 0; i < t0.emergencyContacts.length; i++) {
      const ec = t0.emergencyContacts[i]
      await client.query(
        `INSERT INTO emergency_contacts (
           tenant_id, name, phone, email, relationship, sort_order
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          tenantId,
          ec.name.value,
          ec.phone?.value || null,
          ec.email?.value || null,
          ec.relationship?.value || null,
          i,
        ]
      )
    }
  }

  // Mobile home -- unit-attached, persists across leases
  if (out.mobileHome) {
    const mh = out.mobileHome
    await client.query(
      `INSERT INTO mobile_homes (
         current_owner_tenant_id, unit_id, year, make, model, serial_number,
         hud_label_number, length_ft, width_ft, manufactured_date
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        tenantId, unitId,
        mh.year?.value || null,
        mh.make?.value || null,
        mh.model?.value || null,
        mh.serialNumber?.value || null,
        mh.hudLabelNumber?.value || null,
        mh.lengthFt?.value || null,
        mh.widthFt?.value || null,
        mh.manufacturedDate?.value || null,
      ]
    )
  }

  // RVs -- tenant-owned, persists across leases. Multiple allowed.
  if (out.rvs && out.rvs.length > 0) {
    for (const rv of out.rvs) {
      await client.query(
        `INSERT INTO rvs (
           current_owner_tenant_id, unit_id, year, make, model, vin,
           length_ft, num_slides, hookup_class, license_plate, plate_state
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          tenantId, unitId,
          rv.year?.value || null,
          rv.make?.value || null,
          rv.model?.value || null,
          rv.vin?.value || null,
          rv.lengthFt?.value || null,
          rv.numSlides?.value || null,
          rv.hookupClass?.value || null,
          rv.licensePlate?.value || null,
          rv.plateState?.value || null,
        ]
      )
    }
  }

  // Vehicles -- non-RV, parking-only
  if (out.vehicles && out.vehicles.length > 0) {
    for (const v of out.vehicles) {
      await client.query(
        `INSERT INTO lease_vehicles (
           lease_id, owner_tenant_id, vehicle_type, year, make, model, color, license_plate, plate_state
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          leaseId, tenantId,
          v.vehicleType.value,
          v.year?.value || null,
          v.make?.value || null,
          v.model?.value || null,
          v.color?.value || null,
          v.licensePlate?.value || null,
          v.plateState?.value || null,
        ]
      )
    }
  }

  // Pets
  if (out.pets && out.pets.length > 0) {
    for (const p of out.pets) {
      await client.query(
        `INSERT INTO lease_pets (
           lease_id, name, species, breed, color, age_years, weight_lbs,
           is_service_animal, is_emotional_support
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          leaseId,
          p.name?.value || null,
          p.species.value,
          p.breed?.value || null,
          p.color?.value || null,
          p.ageYears?.value || null,
          p.weightLbs?.value || null,
          p.isServiceAnimal?.value === true,
          p.isEmotionalSupport?.value === true,
        ]
      )
    }
  }

  // Additional occupants -- non-tenant residents
  if (out.additionalOccupants && out.additionalOccupants.length > 0) {
    for (const o of out.additionalOccupants) {
      await client.query(
        `INSERT INTO lease_occupants (
           lease_id, full_name, relationship_to_primary_tenant, date_of_birth, is_minor
         ) VALUES ($1, $2, $3, $4, $5)`,
        [
          leaseId,
          o.fullName.value,
          o.relationshipToPrimaryTenant?.value || null,
          o.dateOfBirth?.value || null,
          o.isMinor?.value === true,
        ]
      )
    }
  }

  // Liability insurance
  if (out.liabilityInsurance) {
    const li = out.liabilityInsurance
    if (li.carrierName?.value || li.policyNumber?.value) {
      await client.query(
        `INSERT INTO liability_insurance_policies (
           lease_id, carrier_name, policy_number, expiry_date
         ) VALUES ($1, $2, $3, $4)`,
        [
          leaseId,
          li.carrierName?.value || null,
          li.policyNumber?.value || null,
          li.expiryDate?.value || null,
        ]
      )
    }
  }
}

// ---------------------------------------------------------------------
// Field-level merge of landlord overrides ON TOP of stored parser output.
// Per-field semantics: override key present -> override wins. Override key
// absent -> parser value preserved. Object-level replacement is wrong here
// because the landlord may correct only one field of the ParserOutput.
//
// "Field" in this context means a ParserExtractedField<T> -- not its
// internal {value, confidence, rawText} shape. The override should be
// shaped the same way: full ParserExtractedField wrappers, not bare values.
// ---------------------------------------------------------------------
function mergeParserOutput(
  base: ParserOutput | null,
  overrides: Partial<ParserOutput>,
): ParserOutput {
  const baseSafe: ParserOutput = base ?? {
    tenants: [],
    unit:    {} as ParserOutput['unit'],
    lease:   {} as ParserOutput['lease'],
    parserVersion: 'gam-parser-0.0.0',
    parsedAt: new Date().toISOString(),
  }
  return {
    ...baseSafe,
    ...overrides,
    tenants: overrides.tenants ? mergeTenants(baseSafe.tenants, overrides.tenants) : baseSafe.tenants,
    unit:    overrides.unit  ? { ...baseSafe.unit,  ...overrides.unit  } : baseSafe.unit,
    lease:   overrides.lease ? { ...baseSafe.lease, ...overrides.lease } : baseSafe.lease,
    extractionExtras: { ...(baseSafe.extractionExtras || {}), ...(overrides.extractionExtras || {}) },
  }
}

function mergeTenants(
  base: ParserOutput['tenants'],
  overrides: ParserOutput['tenants'],
): ParserOutput['tenants'] {
  const out: ParserOutput['tenants'] = []
  const len = Math.max(base.length, overrides.length)
  for (let i = 0; i < len; i++) {
    const b = base[i]
    const o = overrides[i]
    if (b && o)      out.push({ ...b, ...o })
    else if (b)      out.push(b)
    else if (o)      out.push(o)
  }
  return out
}
