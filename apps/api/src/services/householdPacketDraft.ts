/**
 * S653 (Nic) — ONE way to put an approved household on a space.
 *
 *   "It needs to draft a lease for my signature first, not just the fucking
 *    little window that pops up for nothing."
 *
 * Both approval doors — a cleared background check and a listings-marketplace
 * application — used to write a bare `leases` row (no tenant on it, no
 * document) and open an edit form on it. That form is gone. What an approval
 * does now is exactly what the Tenants-page invite does: record the household
 * on the space as a unit-bound intent, draft the SIGNING PACKET off the unit's
 * default template with the applicant on it as primary, and email the landlord
 * their signing link. The lease row is created by the packet, the way every
 * other lease on the platform is.
 */
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'
import { logger } from '../lib/logger'

export interface HouseholdPacketInput {
  unitId: string
  /** The applicant's user; their tenant row is found or created. */
  applicantUserId: string
  /** Companies the caller may act for — the unit must belong to one of them. */
  landlordScope: string[]
  startDate?: string | null       // YYYY-MM-DD they said they are moving in
  termMonths?: number | null
  monthToMonth?: boolean
  actorUserId?: string | null
}

export interface HouseholdPacketResult {
  unitId: string
  unitNumber: string
  tenantId: string
  documentId: string | null
  drafted: boolean
  /** No default template for this unit type: the household is recorded on the
   *  space and the hourly sweep drafts as soon as one is set. */
  needsTemplate: boolean
}

export async function draftPacketForHousehold(input: HouseholdPacketInput): Promise<HouseholdPacketResult> {
  const unit = await queryOne<any>(
    `SELECT u.id, u.unit_number, u.property_id, p.landlord_id
       FROM units u JOIN properties p ON p.id = u.property_id
      WHERE u.id = $1`, [input.unitId])
  if (!unit || !input.landlordScope.includes(unit.landlord_id)) throw new AppError(404, 'Unit not found')

  // The roster is tenants, not users.
  let tenantId = (await queryOne<{ id: string }>(
    'SELECT id FROM tenants WHERE user_id = $1', [input.applicantUserId]))?.id ?? null
  if (!tenantId) {
    tenantId = (await queryOne<{ id: string }>(
      'INSERT INTO tenants (user_id) VALUES ($1) RETURNING id', [input.applicantUserId]))!.id
  }

  // Already drafted and still live: a second click returns the same packet.
  const existing = await queryOne<{ document_id: string }>(
    `SELECT d.id AS document_id
       FROM pending_tenant_intents pti JOIN lease_documents d ON d.id = pti.draft_document_id
      WHERE pti.tenant_id = $1 AND pti.unit_id = $2 AND pti.cancelled_at IS NULL AND pti.resolved_at IS NULL
        AND d.status <> 'voided'`, [tenantId, unit.id])
  if (existing) {
    return { unitId: unit.id, unitNumber: unit.unit_number, tenantId, documentId: existing.document_id, drafted: false, needsTemplate: false }
  }

  // The household on the space — the same row the invite writes, so the Front
  // Desk, the drafting sweep and acceptance all see this person the same way.
  await query(
    `INSERT INTO pending_tenant_intents (landlord_id, tenant_id, parser_status, unit_id, property_id)
     VALUES ($1, $2, 'not_uploaded', $3, $4)
     ON CONFLICT (tenant_id, unit_id) WHERE cancelled_at IS NULL AND unit_id IS NOT NULL
     DO UPDATE SET resolved_at = NULL, accepted_at = NULL, draft_document_id = NULL, updated_at = NOW()`,
    [unit.landlord_id, tenantId, unit.id, unit.property_id])

  const client = await getClient()
  let draftedDocumentIds: string[] = []
  try {
    await client.query('BEGIN')
    const { autoDraftLeasesForUnit } = await import('./leaseOnboarding')
    const { createDocumentRecord } = await import('../routes/esign')
    const out = await autoDraftLeasesForUnit(client as any, unit.id, createDocumentRecord, {
      startDate: input.startDate ?? null,
      termMonths: input.termMonths ?? null,
      monthToMonth: input.monthToMonth === true,
    })
    await client.query('COMMIT')
    draftedDocumentIds = out.draftedDocumentIds
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally { client.release() }

  // Send AFTER the commit (S636). Best-effort: mail must not undo the draft.
  const { autoSendDraftedDocument } = await import('../routes/esign')
  for (const docId of draftedDocumentIds) {
    await autoSendDraftedDocument(docId).catch(err =>
      logger.error({ err, docId }, '[household-packet] auto-send after draft failed'))
  }
  logger.info({ unitId: unit.id, tenantId, draftedDocumentIds, by: input.actorUserId ?? null },
    '[household-packet] approval drafted the lease packet')
  return {
    unitId: unit.id, unitNumber: unit.unit_number, tenantId,
    documentId: draftedDocumentIds[0] ?? null,
    drafted: draftedDocumentIds.length > 0,
    needsTemplate: draftedDocumentIds.length === 0,
  }
}
