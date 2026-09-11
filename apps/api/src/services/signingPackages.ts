/**
 * S641 — which documents this tenant signs, and in what order.
 *
 * Nic: "having it all kinda bundled together in a package type format would
 * make life easier… a lot of people are gonna be like, well, I already signed
 * the lease, what's this for? And it's like, okay, that's your installment sale
 * contract."
 *
 * The package is chosen at DRAFT time, not at invite. Nic raised the question
 * himself — "I don't know if we would do that at the invite stage" — and draft
 * is the answer: at invite you often do not yet know whether this person is
 * work-trade or buying on installment. So the landlord gets a pre-ticked
 * checklist at the moment they already know the tenant.
 */
import { query, queryOne } from '../db'

export type RenewalBehavior = 'with_lease' | 'once_per_tenancy' | 'on_version_change'

export interface PackageItem {
  itemId: string
  templateId: string
  templateName: string
  purpose: string
  version: number
  sortOrder: number
  renewalBehavior: RenewalBehavior
  /** The landlord cannot untick this one on the draft screen. */
  required: boolean
  /** Pre-ticked on the draft screen. */
  suggested: boolean
  /** Why it is or is not suggested, in words a person can read. */
  reason: string
}

export interface ResolvedPackage {
  packageId: string
  name: string
  items: PackageItem[]
}

/**
 * Is this template allowed at this property?
 *
 * No pin rows at all means "available everywhere" — the statement of policy,
 * lead paint, a bed bug disclosure. Rows mean "only these properties", which is
 * the guardrail Nic asked for: assigned-parking rules must not reach a property
 * with no assigned parking.
 */
export async function templatePropertyIds(templateId: string): Promise<string[]> {
  const rows = await query<{ property_id: string }>(
    `SELECT property_id FROM lease_template_properties WHERE template_id = $1`, [templateId])
  return rows.map(r => r.property_id)
}

/** Pin a template to exactly this set of properties. Empty set = everywhere. */
export async function setTemplateProperties(templateId: string, propertyIds: string[]): Promise<void> {
  await query(`DELETE FROM lease_template_properties WHERE template_id = $1`, [templateId])
  for (const pid of [...new Set(propertyIds)]) {
    await query(
      `INSERT INTO lease_template_properties (template_id, property_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`, [templateId, pid])
  }
}

/**
 * The package a landlord would reach for when drafting on this unit, with every
 * item marked as suggested or not.
 *
 * Nothing here BLOCKS. An item that does not apply is simply unticked, and the
 * landlord can tick it anyway — the platform does not decide what belongs in
 * somebody's lease.
 */
export async function resolvePackageForUnit(params: {
  landlordId: string
  unitId: string
  packageId?: string | null
}): Promise<ResolvedPackage | null> {
  const unit = await queryOne<{ property_id: string; unit_type: string | null }>(
    `SELECT property_id, unit_type FROM units WHERE id = $1`, [params.unitId])
  if (!unit) return null

  const pkg = params.packageId
    ? await queryOne<any>(
        `SELECT id, name FROM document_packages
          WHERE id = $1 AND landlord_id = $2 AND archived_at IS NULL`,
        [params.packageId, params.landlordId])
    // The default for this unit type, else a landlord-wide default.
    : await queryOne<any>(
        `SELECT id, name FROM document_packages
          WHERE landlord_id = $1 AND archived_at IS NULL AND is_default
            AND (unit_type = $2 OR unit_type IS NULL)
          ORDER BY (unit_type IS NOT NULL) DESC
          LIMIT 1`,
        [params.landlordId, unit.unit_type])
  if (!pkg) return null

  const rows = await query<any>(
    `SELECT i.id AS item_id, i.template_id, i.sort_order, i.renewal_behavior, i.required,
            t.name AS template_name, t.purpose, t.version,
            (SELECT COUNT(*) FROM lease_template_properties tp
              WHERE tp.template_id = t.id)::int AS pin_count,
            EXISTS (SELECT 1 FROM lease_template_properties tp
                     WHERE tp.template_id = t.id AND tp.property_id = $2) AS pinned_here,
            t.unit_type AS template_unit_type
       FROM document_package_items i
       JOIN lease_templates t ON t.id = i.template_id
      WHERE i.package_id = $1
      ORDER BY i.sort_order, t.name`,
    [pkg.id, unit.property_id])

  const items: PackageItem[] = rows.map(r => {
    let suggested = true
    let reason = 'Applies to this unit'

    if (r.pin_count > 0 && !r.pinned_here) {
      suggested = false
      reason = 'Not used at this property'
    } else if (r.template_unit_type && unit.unit_type && r.template_unit_type !== unit.unit_type) {
      suggested = false
      reason = `Written for ${String(r.template_unit_type).replace(/_/g, ' ')}`
    } else if (r.required) {
      reason = 'Always included'
    }

    return {
      itemId: r.item_id,
      templateId: r.template_id,
      templateName: r.template_name,
      purpose: r.purpose,
      version: Number(r.version),
      sortOrder: Number(r.sort_order),
      renewalBehavior: r.renewal_behavior as RenewalBehavior,
      required: r.required === true,
      // A required item is always ticked, whatever the pinning says — the
      // landlord decided it is mandatory and that outranks our inference.
      suggested: r.required === true ? true : suggested,
      reason,
    }
  })

  return { packageId: pkg.id, name: pkg.name, items }
}

/**
 * What comes back around at renewal.
 *
 * Nic: "I don't think the whole package needs to come back around, but it also
 * doesn't need to be just the lease. It needs to be pertinent to whatever the
 * situation is."
 *
 * So each item answers for itself, and one of the three answers is a fact
 * rather than a rule: on_version_change asks whether the landlord has published
 * a version newer than the one this tenant already agreed to. That same
 * question covers a mid-tenancy change, so park rules do not need a second
 * mechanism to go out when they change.
 */
export async function itemsDueAtRenewal(params: {
  packageId: string
  leaseId: string
}): Promise<Array<{ templateId: string; templateName: string; why: string }>> {
  const rows = await query<any>(
    `SELECT i.template_id, i.renewal_behavior, t.name AS template_name, t.version,
            (SELECT MAX(d.template_version)
               FROM lease_documents d
              WHERE d.template_id = i.template_id
                AND d.lease_id = $2
                AND d.status = 'completed') AS signed_version
       FROM document_package_items i
       JOIN lease_templates t ON t.id = i.template_id
      WHERE i.package_id = $1
      ORDER BY i.sort_order`,
    [params.packageId, params.leaseId])

  const due: Array<{ templateId: string; templateName: string; why: string }> = []
  for (const r of rows) {
    if (r.renewal_behavior === 'with_lease') {
      due.push({ templateId: r.template_id, templateName: r.template_name, why: 'New term' })
    } else if (r.renewal_behavior === 'on_version_change') {
      const signed = r.signed_version == null ? null : Number(r.signed_version)
      // Never signed, or signed an older version. A tenant who has already
      // agreed to the current version is not asked again.
      if (signed == null || signed < Number(r.version)) {
        due.push({
          templateId: r.template_id,
          templateName: r.template_name,
          why: signed == null ? 'Never signed' : 'Updated since they signed it',
        })
      }
    }
    // once_per_tenancy: signed at onboarding, referenced afterwards. Re-executing
    // a five-year purchase contract because the lot lease renewed would muddy
    // when the five years started.
  }
  return due
}

/**
 * Bump a template's version. Called when the PDF or the field layout changes —
 * that is what makes "has this changed since they agreed to it" answerable.
 */
export async function bumpTemplateVersion(templateId: string): Promise<number> {
  const row = await queryOne<{ version: number }>(
    `UPDATE lease_templates SET version = version + 1, updated_at = now()
      WHERE id = $1 RETURNING version`, [templateId])
  return row?.version ?? 1
}

/**
 * Draft every selected item of a package as ONE signing bundle.
 *
 * Nic: "when the lease is autodrafted, it combines them all together… having it
 * all bundled together in a package type format would make life easier."
 *
 * The bundle shares a group id and an order, so the tenant sees "document 2 of
 * 4" and one completion rather than a series of unrelated requests arriving
 * days apart. Each document still executes as its own instrument — that is what
 * keeps an installment contract separable from a lot lease, which is the whole
 * point at Country Acres.
 *
 * Called INSIDE the caller's transaction: a half-assembled package is worse
 * than none, because the tenant would sign part of an agreement.
 */
export interface AssembleItem {
  templateId: string
  title: string
  documentType: string
  sortOrder: number
  version: number
}

export async function assemblePackageDocuments(
  client: { query: Function },
  params: {
    landlordId: string
    unitId: string | null
    leaseId: string | null
    packageId: string | null
    packageGroupId: string
    items: AssembleItem[]
    createOne: (item: AssembleItem, groupId: string, order: number) => Promise<any>
  },
): Promise<any[]> {
  const created: any[] = []
  // Order matters: the lease first, then whatever explains or qualifies it.
  const ordered = [...params.items].sort((a, b) => a.sortOrder - b.sortOrder)
  for (let i = 0; i < ordered.length; i++) {
    created.push(await params.createOne(ordered[i], params.packageGroupId, i))
  }
  return created
}

/**
 * The other documents in this document's bundle, in order — what the signing
 * screen needs to say "2 of 4" and to move somebody to the next one.
 */
export async function packageSiblings(documentId: string): Promise<Array<{
  id: string; title: string; status: string; sortOrder: number; isSelf: boolean
}>> {
  const rows = await query<any>(
    `SELECT d.id, d.title, d.status, COALESCE(d.package_sort_order, 0) AS sort_order
       FROM lease_documents d
      WHERE d.package_group_id = (SELECT package_group_id FROM lease_documents WHERE id = $1)
        AND d.package_group_id IS NOT NULL
        AND d.voided_at IS NULL
      ORDER BY d.package_sort_order, d.created_at`,
    [documentId])
  return rows.map(r => ({
    id: r.id, title: r.title, status: r.status,
    sortOrder: Number(r.sort_order), isSelf: r.id === documentId,
  }))
}
