// S605 (Nic): auto-draft the lease for a newly-invited household.
//
// The landlord's ask: "I invite a tenant, I type their name and email, and it
// just kind of completes the process on its own." Inviting created accounts and
// then stopped — drafting the lease was a separate trip the landlord had to
// remember to make, per unit, for every tenancy.
//
// TEMPLATE-DRIVEN, NOT LANDLORD-SPECIFIC. Nic: "the chain needs to look for that
// unit type's default lease template. When nothing is set, it can't fire, but
// you can build the structure so that as soon as I add a template it would fire.
// Because if you're gonna build this structure off of a template I haven't
// uploaded yet, that means it's gonna fail for every other landlord."
//
// So this resolves the DEFAULT TEMPLATE FOR THE UNIT'S TYPE at draft time and
// returns a reason when there isn't one. No landlord, property or unit type is
// special-cased: a landlord who has configured a template for that unit type
// gets a draft, one who hasn't gets a clear "configure it" answer, and the
// moment they upload one the same invite path starts producing drafts.
//
// LANDLORD SIGNS FIRST — deliberately. Nic: "the landlord will get a last glance
// at every lease... so if there's any problems, the landlord can cancel all the
// bad leases and make whatever changes necessary. That's kind of a last safety
// check step." The landlord is signer 1 and residents are 2..N, so nothing
// reaches a tenant until a human has looked at it.
import { queryOne, query, getClient } from '../db'
import { resolveDefaultTemplateForUnit } from './templateResolve'
import { resolveLeaseSigner } from './leaseSigner'
import { createDocumentRecord } from '../routes/esign'
import { logger } from '../lib/logger'

export type HouseholdDraftResult =
  | { drafted: true; documentId: string; templateId: string }
  | { drafted: false; reason: string }

/**
 * Draft an original lease for every tenant currently invited to a unit.
 *
 * Best-effort by contract: the caller (the invite route) must not fail because
 * a draft could not be produced — the accounts are real and the landlord can
 * always draft by hand. Every non-draft path returns a REASON rather than
 * throwing, so the invite response can say why.
 */
export async function draftHouseholdLease(args: {
  landlordId: string
  unitId: string
  /** Every resident invited to this unit, in household order (primary first). */
  residents: Array<{ userId: string; name: string; email: string; phone?: string | null }>
}): Promise<HouseholdDraftResult> {
  const { landlordId, unitId, residents } = args
  if (!residents.length) return { drafted: false, reason: 'No residents to draft for' }

  const template = await resolveDefaultTemplateForUnit(unitId)
  if (!template) {
    // The expected state for a landlord who hasn't set templates up yet. Name
    // the unit type so the message points at the exact thing to configure.
    const u = await queryOne<{ unit_type: string | null }>(
      `SELECT unit_type FROM units WHERE id = $1`, [unitId])
    return {
      drafted: false,
      reason: `No default lease template is set for ${u?.unit_type ? `"${u.unit_type}" units` : 'this unit type'}. ` +
        `Set one under Leases → Templates and the lease will draft automatically on the next invite.`,
    }
  }
  if (!template.base_pdf_url) {
    return { drafted: false, reason: 'That unit type’s default template has no uploaded document yet.' }
  }

  // Landlord signs first — see the header. S605: the signer is the property's
  // DESIGNATED on-site manager when one is set and still entitled, otherwise the
  // account owner. resolveLeaseSigner re-checks entitlement, so a manager who
  // has been removed or had leases.sign revoked falls back to the owner without
  // anyone having to remember to clear the setting.
  const unitProp = await queryOne<{ property_id: string }>(
    `SELECT property_id FROM units WHERE id = $1`, [unitId])
  const signer = await resolveLeaseSigner(landlordId, unitProp?.property_id ?? null)
  if (!signer) return { drafted: false, reason: 'Could not resolve the landlord signer' }

  // Don't stack drafts: re-inviting, or a second resident arriving later,
  // must not produce a second unsigned lease for the same unit.
  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM lease_documents
      WHERE unit_id = $1 AND document_type = 'original_lease'
        AND status NOT IN ('completed','voided')
      LIMIT 1`, [unitId])
  if (existing) {
    return { drafted: false, reason: 'A lease for this unit is already awaiting signature.' }
  }

  const unit = await queryOne<{ unit_number: string; property_name: string }>(
    `SELECT u.unit_number, p.name AS property_name
       FROM units u JOIN properties p ON p.id = u.property_id
      WHERE u.id = $1`, [unitId])

  const client = await getClient()
  try {
    await client.query('BEGIN')
    const doc = await createDocumentRecord(client, {
      landlordId,
      templateId: template.id,
      unitId,
      leaseId: null,
      title: `Lease — ${unit?.property_name ?? 'Property'} ${unit?.unit_number ?? ''}`.trim(),
      basePdfUrl: template.base_pdf_url,
      documentType: 'original_lease' as any,
      targetLeaseTenantId: null,
      promoteLeaseTenantId: null,
      signers: [
        // orderIndex 1 = the landlord's last-glance review.
        { userId: signer.userId, role: 'landlord', name: signer.name,
          email: signer.email, phone: signer.phone, orderIndex: 1 },
        // Residents sign after, in household order — primary first.
        ...residents.map((r, i) => ({
          userId: r.userId, role: 'tenant', name: r.name, email: r.email,
          phone: r.phone ?? null, orderIndex: i + 2,
        })),
      ],
    })
    // Waiting rows are closed out inside createDocumentRecord — every lease
    // document goes through it, so a hand-sent lease clears them too.
    await client.query('COMMIT')
    logger.info({ unitId, documentId: doc.id, residents: residents.length },
      '[household-draft] lease drafted, awaiting landlord signature')
    return { drafted: true, documentId: doc.id, templateId: template.id }
  } catch (e: any) {
    await client.query('ROLLBACK')
    logger.error({ err: e, unitId }, '[household-draft] draft failed')
    return { drafted: false, reason: 'Could not draft the lease automatically — you can send it manually from the unit.' }
  } finally {
    client.release()
  }
}

/** Resolve invited residents by email, in the order given (primary first).
 *
 *  The invite deliberately does NOT persist a tenant→unit link — it uses the
 *  unit only to resolve the landlord, because unit assignment belongs to the
 *  lease, not the invitation. So the household is identified by the emails the
 *  landlord just invited, and every one of them is checked to be a real tenant
 *  account under THIS landlord before it can be written onto a lease. */
export async function resolveHouseholdByEmail(
  landlordId: string, emails: string[],
): Promise<Array<{ userId: string; name: string; email: string; phone: string | null }>> {
  const out: Array<{ userId: string; name: string; email: string; phone: string | null }> = []
  for (const email of emails) {
    // `tenants` carries NO landlord column — a tenant is tied to a landlord only
    // through a lease, and at invite time there isn't one yet. So the guard is
    // the same one the invite itself applies: the account must be a tenant, and
    // must not be ACTIVELY LEASED to a different landlord. Combined with the
    // caller having to manage this unit, that stops a landlord naming a stranger
    // (or another landlord's sitting tenant) as a signer on their lease.
    const row = await queryOne<any>(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone
         FROM users u
         JOIN tenants t ON t.user_id = u.id
        WHERE lower(u.email) = lower($1)
          AND u.role = 'tenant'
          AND NOT EXISTS (
            SELECT 1
              FROM lease_tenants lt
              JOIN leases l ON l.id = lt.lease_id
             WHERE lt.tenant_id = t.id
               AND lt.status = 'active'
               AND l.status = 'active'
               AND l.landlord_id <> $2)
        LIMIT 1`, [email, landlordId])
    if (!row) continue     // unknown, or leased elsewhere — skip, never guess
    out.push({
      userId: row.id,
      name: `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || row.email,
      email: row.email, phone: row.phone,
    })
  }
  return out
}

/**
 * S605 (Nic): retry drafting for every unit still waiting on a template.
 *
 * "If somebody does forget to add the template first... have something to
 * remember which unit the tenant was invited to, so that when they add it, it
 * refires."
 *
 * Called when a template is made the default for a unit type. Walks the units of
 * that type with unresolved invites and drafts each household in invite order.
 * Best-effort per unit: one unit that can't draft (already has a lease awaiting
 * signature, say) must not stop the rest.
 */
export async function draftPendingForUnitType(args: {
  landlordId: string
  unitType: string
  propertyId?: string | null
}): Promise<{
  drafted: number
  skipped: number
  /** S605: WHICH units didn't draft and why. A bare count ("18 drafted, 1
   *  skipped") tells a landlord nothing about what to go and fix — and a
   *  partially-drafted run is exactly when they need to know. */
  skippedUnits: Array<{ unitId: string; unitNumber: string | null; reason: string }>
}> {
  const { landlordId, unitType, propertyId } = args
  const params: any[] = [landlordId, unitType]
  let scope = ''
  if (propertyId) { params.push(propertyId); scope = ` AND u.property_id = $${params.length}` }

  // S629 (Nic): BOTH invite tables, not one.
  //
  // This read pending_lease_drafts only. "New Lease — Invite to Sign" writes
  // pending_tenant_intents, so a unit invited through that door was invisible
  // to the retry: Nic set a default template exactly as the notification told
  // him to, the endpoint reported success, and RV 24 still had no lease
  // because the retry had looked in the wrong place and found nothing.
  //
  // Third time tonight these two tables have diverged — the invite-eligibility
  // filter and the pending-invite count were the others. Any code that asks
  // "who is waiting on a lease here" has to ask both.
  const units = await query<{ unit_id: string }>(
    `SELECT DISTINCT unit_id FROM (
       SELECT p.unit_id, p.landlord_id, u.unit_type, u.property_id
         FROM pending_lease_drafts p
         JOIN units u ON u.id = p.unit_id
        WHERE p.resolved_at IS NULL
       UNION
       SELECT pti.unit_id, pti.landlord_id, u2.unit_type, u2.property_id
         FROM pending_tenant_intents pti
         JOIN units u2 ON u2.id = pti.unit_id
        WHERE pti.resolved_at IS NULL AND pti.cancelled_at IS NULL
          AND pti.accepted_at IS NOT NULL
          AND pti.draft_document_id IS NULL
     ) AS u
     WHERE u.landlord_id = $1
       AND u.unit_type = $2${scope}`, params)

  let drafted = 0, skipped = 0
  const skippedUnits: Array<{ unitId: string; unitNumber: string | null; reason: string }> = []
  const noteSkip = async (unitId: string, reason: string) => {
    skipped++
    const u = await queryOne<{ unit_number: string }>(
      `SELECT unit_number FROM units WHERE id = $1`, [unitId])
    skippedUnits.push({ unitId, unitNumber: u?.unit_number ?? null, reason })
  }

  for (const { unit_id } of units) {
    // S629: a unit invited through "New Lease — Invite to Sign" has its roster
    // in pending_tenant_intents, and its drafting rules live in
    // autoDraftLeasesForUnit — whole-unit waits for everyone to accept,
    // by-room drafts per person. Re-deriving that here would be a second
    // implementation of the rule that decides who is on a lease, so the retry
    // delegates to the same function the accept path uses.
    const intentWaiting = await queryOne<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pending_tenant_intents
        WHERE unit_id = $1 AND resolved_at IS NULL AND cancelled_at IS NULL
          AND accepted_at IS NOT NULL AND draft_document_id IS NULL`, [unit_id])
    if (Number(intentWaiting?.n || 0) > 0) {
      const client = await getClient()
      try {
        await client.query('BEGIN')
        const { autoDraftLeasesForUnit } = await import('./leaseOnboarding')
        const { createDocumentRecord } = await import('../routes/esign')
        const out = await autoDraftLeasesForUnit(client as any, unit_id, createDocumentRecord)
        await client.query('COMMIT')
        // S636: same rule as the accept path — the send only works once the
        // document is committed and a pool connection can see it.
        if (out.draftedDocumentIds.length) {
          const { autoSendDraftedDocument } = await import('../routes/esign')
          for (const docId of out.draftedDocumentIds) {
            await autoSendDraftedDocument(docId).catch(err =>
              logger.error({ err, docId }, '[household-draft] auto-send after draft failed'))
          }
        }
        if (out.draftedDocumentIds.length) drafted++
        else {
          // S636: SAY WHICH REASON. This reported every non-draft as "waiting on
          // the rest of the household", including the one cause the landlord can
          // actually act on — no default template for the unit type. At Mountain
          // View that pointed Nic at his residents when the answer was an
          // unbuilt RV template, and a household genuinely waiting on a
          // co-tenant looks identical to one blocked on setup.
          const tmpl = await resolveDefaultTemplateForUnit(unit_id)
          const waiting = await queryOne<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM pending_tenant_intents
              WHERE unit_id = $1 AND resolved_at IS NULL AND cancelled_at IS NULL
                AND accepted_at IS NULL`, [unit_id])
          const stillToAccept = Number(waiting?.n || 0)
          const tmplFields = tmpl ? await queryOne<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM lease_template_fields WHERE template_id = $1`,
            [tmpl.id]) : null
          await noteSkip(unit_id,
            !tmpl
              ? 'No default lease template is set for this unit type. Set one under Leases → '
                + 'Templates and this drafts automatically.'
            : !tmpl.base_pdf_url
              ? 'That unit type’s default template has no uploaded document yet.'
            : Number(tmplFields?.n || 0) === 0
              // The Mountain View case: the template was uploaded and its
              // auto-placement finished, but the landlord has not opened it and
              // SAVED the proposed fields, so it has none. Reported as "waiting
              // on the household", which sent Nic looking at his residents.
              ? 'That unit type’s default template has no fields saved yet — open it in the '
                + 'template editor and save the auto-placed fields.'
            : stillToAccept > 0
              ? `Waiting on ${stillToAccept} more of the household to accept`
              // Everyone accepted, the template looks complete, and drafting
              // still refused — the reason is specific (e.g. the late-fee policy
              // must appear in the document) and was sent as its own
              // notification. Never guess at it here.
              : 'The draft was refused — see the "Lease could not be drafted automatically" '
                + 'notification for the reason.')
        }
      } catch (e: any) {
        await client.query('ROLLBACK').catch(() => {})
        await noteSkip(unit_id, e?.message || 'Could not draft')
      } finally { client.release() }
      continue
    }

    const residents = await query<any>(
      `SELECT us.id AS user_id, us.email, us.phone,
              TRIM(COALESCE(us.first_name,'') || ' ' || COALESCE(us.last_name,'')) AS name
         FROM pending_lease_drafts p
         JOIN users us ON us.id = p.tenant_user_id
        WHERE p.unit_id = $1 AND p.resolved_at IS NULL
        ORDER BY p.household_order`, [unit_id])
    if (!residents.length) { await noteSkip(unit_id, 'No residents left waiting on this unit'); continue }
    const res = await draftHouseholdLease({
      landlordId, unitId: unit_id,
      residents: residents.map(r => ({
        userId: r.user_id, name: r.name || r.email, email: r.email, phone: r.phone,
      })),
    })
    if (res.drafted) drafted++
    else {
      await noteSkip(unit_id, res.reason)
      logger.info({ unitId: unit_id, reason: res.reason }, '[household-draft] retry skipped')
    }
  }
  if (drafted || skipped) {
    logger.info({ landlordId, unitType, drafted, skipped, skippedUnits },
      '[household-draft] template default set — retried pending')
  }
  return { drafted, skipped, skippedUnits }
}

/**
 * S605 (Nic): sweep every landlord for households still waiting on a lease.
 *
 * "What initiates the retry? Is it just retry after a certain amount of time?"
 * Until this, the ONLY trigger was saving a template as a unit-type default —
 * so a draft that failed for any other reason (a transient database error, a
 * template uploaded without its PDF, a lease voided after the fact) sat
 * unresolved forever and the landlord had to notice by themselves.
 *
 * Anything still waiting is retried. Resolved rows are skipped, so a settled
 * queue costs one indexed query and nothing else.
 */
export async function draftAllPendingLeases(): Promise<{ drafted: number; skipped: number }> {
  // S636 (bug): THE SWEEP ONLY SAW HALF THE RESIDENTS WAITING.
  //
  // It enumerated `pending_lease_drafts` alone. A resident invited through
  // "New Lease — Invite to Sign" has their roster in `pending_tenant_intents`
  // instead, and draftPendingForUnitType handles that shape perfectly well — it
  // was simply never asked to, because nothing put those units in this list.
  //
  // So the retry that exists precisely to rescue a household stuck behind a
  // missing template did not cover the invite path, which is the path every
  // Mountain View resident came in through. Nine people accepted, every draft
  // failed, and the net underneath them was empty. A stuck household is invisible
  // by nature — the landlord sees "invite accepted" and assumes a lease followed
  // — so the sweep is the only thing that would ever notice.
  //
  // UNION of both sources: a unit waiting in either place is a unit to retry.
  const groups = await query<{ landlord_id: string; unit_type: string }>(
    `SELECT DISTINCT p.landlord_id, u.unit_type
       FROM pending_lease_drafts p
       JOIN units u ON u.id = p.unit_id
      WHERE p.resolved_at IS NULL AND u.unit_type IS NOT NULL
     UNION
     SELECT DISTINCT pti.landlord_id, u.unit_type
       FROM pending_tenant_intents pti
       JOIN units u ON u.id = pti.unit_id
      WHERE pti.accepted_at IS NOT NULL
        AND pti.draft_document_id IS NULL
        AND pti.resolved_at IS NULL
        AND pti.cancelled_at IS NULL
        AND u.unit_type IS NOT NULL`)

  let drafted = 0, skipped = 0
  for (const g of groups) {
    const r = await draftPendingForUnitType({ landlordId: g.landlord_id, unitType: g.unit_type })
      .catch(() => ({ drafted: 0, skipped: 0, skippedUnits: [] }))
    drafted += r.drafted
    skipped += r.skipped
  }
  return { drafted, skipped }
}
