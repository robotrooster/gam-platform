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
import { query, queryOne, getClient } from '../db'
import { AppError } from '../middleware/errorHandler'

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
/**
 * S652 — what KIND of transaction this household is having.
 *
 * Nic: "you needed to detect who was on rent to own or already tenant owned
 * homes and apply that to the thing, and have the leases that are just not on
 * rent to own as the leased lead based paint disclosure."
 *
 * Three cases at Country Acres, and the database already knows which is which
 * without anybody keeping a list:
 *
 *   'sale'   — the park owns the home and the household is buying it on
 *              installments. A sale is happening, so sale-side disclosures
 *              apply on top of the lease for the lot.
 *   'rental' — the park owns the home and is renting it out. The landlord is
 *              providing the dwelling, so rental disclosures apply.
 *   'lot'    — the household already owns their home outright. The landlord is
 *              renting LAND, not housing, so a disclosure about the condition
 *              of a dwelling he does not own and does not provide is not his to
 *              make. Suggested off, never blocked: GAM accommodates, it does
 *              not rule on what a landlord must sign. (memory:
 *              gam-never-gate-on-legality)
 */
export type TransactionKind = 'sale' | 'rental' | 'lot'

export async function transactionKindForUnit(unitId: string): Promise<TransactionKind> {
  const unit = await queryOne<{ dwelling_ownership: string | null }>(
    `SELECT dwelling_ownership FROM units WHERE id = $1`, [unitId])
  // A sale in flight beats everything: the home is still the park's on paper
  // (ownership flips at payoff), but a sale is what is being papered today.
  const sale = await queryOne<{ id: string }>(
    `SELECT id FROM home_sale_contracts
      WHERE unit_id = $1 AND status IN ('pending_signature', 'active') LIMIT 1`, [unitId])
  if (sale) return 'sale'
  if (unit?.dwelling_ownership === 'tenant') return 'lot'
  return 'rental'
}

export async function resolvePackageForUnit(params: {
  // S652: every company in the account — a package is the account's.
  landlordIds: string[]
  unitId: string
  packageId?: string | null
  // S652: a sale being papered in the same transaction is not visible to the
  // pool yet — the caller says so.
  kind?: TransactionKind
}): Promise<ResolvedPackage | null> {
  const unit = await queryOne<{ property_id: string; unit_type: string | null; state: string | null }>(
    `SELECT u.property_id, u.unit_type, p.state
       FROM units u JOIN properties p ON p.id = u.property_id
      WHERE u.id = $1`, [params.unitId])
  if (!unit) return null

  const pkg = params.packageId
    ? await queryOne<any>(
        `SELECT id, name FROM document_packages
          WHERE id = $1 AND landlord_id = ANY($2::uuid[]) AND archived_at IS NULL`,
        [params.packageId, params.landlordIds])
    // The default for this unit type in this state, else any state, else a
    // package for every unit type.
    : await queryOne<any>(
        `SELECT id, name FROM document_packages
          WHERE landlord_id = ANY($1::uuid[]) AND archived_at IS NULL AND is_default
            AND (unit_type = $2 OR unit_type IS NULL)
            AND (state_code = $3 OR state_code IS NULL)
          ORDER BY (unit_type IS NOT NULL) DESC, (state_code IS NOT NULL) DESC
          LIMIT 1`,
        [params.landlordIds, unit.unit_type, unit.state])
  if (!pkg) return null

  // S652: which disclosures belong in front of THIS household.
  const kind = params.kind ?? await transactionKindForUnit(params.unitId)
  // A lot lease matches neither side — the landlord is renting land, and a
  // disclosure about a dwelling he does not provide is not his to make.
  const wantedAppliesTo = kind === 'sale' ? 'sale' : kind === 'rental' ? 'rental' : null

  const rows = await query<any>(
    `SELECT i.id AS item_id, i.template_id, i.sort_order, i.renewal_behavior, i.required,
            t.name AS template_name, t.purpose, t.version, t.applies_to,
            t.disclosure_type, t.state_code,
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

  // S652: which categories this landlord has a state-specific form for. A
  // general form in the same category is then the fallback, not a duplicate.
  const supersededByStateForm = new Set(
    rows.filter((r: any) => r.disclosure_type && r.state_code && r.state_code === unit.state)
        .map((r: any) => r.disclosure_type as string))

  const items: PackageItem[] = rows.map(r => {
    let suggested = true
    let reason = 'Applies to this unit'

    if (r.pin_count > 0 && !r.pinned_here) {
      suggested = false
      reason = 'Not used at this property'
    } else if (r.template_unit_type && unit.unit_type && r.template_unit_type !== unit.unit_type) {
      suggested = false
      reason = `Written for ${String(r.template_unit_type).replace(/_/g, ' ')}`
    } else if (r.state_code && unit.state && r.state_code !== unit.state) {
      // S652: a form written for another state. Kept in the list — a landlord
      // who wants it says so — but never suggested at a property it was not
      // written for.
      suggested = false
      reason = `Written for ${r.state_code}, and this property is in ${unit.state}`
    } else if (r.disclosure_type && supersededByStateForm.has(r.disclosure_type) && !r.state_code) {
      // The landlord holds a form for THIS state in this same category, so the
      // general one steps aside. Most-specific-wins, said out loud rather than
      // silently dropping one of two documents with the same name.
      suggested = false
      reason = `Superseded by the ${unit.state} version`
    } else if (r.applies_to && r.applies_to !== 'any' && r.applies_to !== wantedAppliesTo) {
      // S652: the sale disclosure on a rental, or the rental one on a sale.
      // Suggested OFF and said out loud — a landlord who wants it anyway ticks
      // it, because GAM does not rule on what somebody must sign.
      suggested = false
      reason = kind === 'lot'
        ? 'The household owns their home — this lease is for the lot'
        : r.applies_to === 'sale'
          ? 'For a home being sold, and this is a rental'
          : 'For a home being rented, and this one is being sold'
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

/**
 * S652 (Nic): "when no packet is set… it should allow you to create the packet
 * from that point." Assemble the default package for this unit's state and
 * kind of space from the landlord's FILLED slots — the same rule as the
 * Packages page's "Fill from my documents": the default lease, every filled
 * document slot (their own upload, or the government's version), nothing that
 * is covered by another document, no notice sent later, no read-only form. An
 * installment sale contract is included when they have one; the draft decides
 * per unit whether a sale is happening. Saved as the default for that state ×
 * unit type so it is simply there next time.
 *
 * Returns the package, or a reason it could not be built — the only real one
 * is "no lease template yet", which is the cue to go upload one.
 */
export async function buildDefaultPackageForUnit(
  landlordIds: string[], unitId: string,
): Promise<{ packageId: string; created: boolean } | { packageId: null; reason: string; needsLease: boolean }> {
  const unit = await queryOne<{ landlord_id: string; unit_type: string | null; state: string | null }>(
    `SELECT u.landlord_id, u.unit_type, p.state FROM units u JOIN properties p ON p.id = u.property_id WHERE u.id = $1`, [unitId])
  if (!unit) throw new AppError(404, 'Unit not found')
  if (!unit.unit_type || !unit.state) return { packageId: null, reason: 'This unit has no kind or state set yet.', needsLease: false }

  const existing = await queryOne<{ id: string }>(
    `SELECT id FROM document_packages WHERE landlord_id = ANY($1::uuid[]) AND archived_at IS NULL AND is_default
        AND (unit_type = $2 OR unit_type IS NULL) AND (state_code = $3 OR state_code IS NULL)
      ORDER BY (unit_type IS NOT NULL) DESC, (state_code IS NOT NULL) DESC LIMIT 1`,
    [landlordIds, unit.unit_type, unit.state])
  if (existing) return { packageId: existing.id, created: false }

  const exec = { query: (sql: string, params: any[]) => query<any>(sql, params).then(r => ({ rows: r })) }
  const { sleevesForLandlord } = await import('./documentSleeves')
  const { adoptLibraryDocument } = await import('./disclosureLibrary')
  const view: any = await sleevesForLandlord(exec, landlordIds)
  const st = view.states.find((x: any) => x.state === unit.state)
  const fits = (u: string[] | null) => !u || u.includes(unit.unit_type!)
  const wanted: Array<{ templateId?: string; lib?: string; purpose: string }> = []
  for (const s of [...(st?.sleeves ?? []), ...(view.federal ?? [])] as any[]) {
    if (!fits(s.unitTypes) || s.coveredBy?.length) continue
    if (s.group === 'notices_later' || s.whenItHappens) continue
    if (s.kind === 'government') {
      if (s.signable === false) continue
      wanted.push(s.cards[0] ? { templateId: s.cards[0].templateId, purpose: 'state_disclosure' } : { lib: s.libraryDocumentId, purpose: 'state_disclosure' })
    } else if (s.cards.length) {
      const pick = s.kind === 'lease' ? (s.cards.find((c: any) => c.isUnitTypeDefault) ?? s.cards[0]) : s.cards[0]
      wanted.push({ templateId: pick.templateId, purpose: s.kind === 'lease' ? 'lease' : s.kind === 'sale_contract' ? 'installment_sale' : 'state_disclosure' })
    } else if (s.freeVersion && s.freeVersion.signable !== false) {
      wanted.push(s.freeVersion.templateId ? { templateId: s.freeVersion.templateId, purpose: s.kind === 'lease' ? 'lease' : 'state_disclosure' }
                                           : { lib: s.freeVersion.libraryDocumentId, purpose: s.kind === 'lease' ? 'lease' : 'state_disclosure' })
    }
  }
  // Not every document is filed in a slot — older uploads, and a test
  // database with no slot catalog at all. The unit type's default lease is the
  // lease whatever slot it sits in, and unfiled documents that fit this kind
  // of unit ride along, the way the Templates page lists them under Other.
  if (!wanted.some(w => w.purpose === 'lease')) {
    const { resolveDefaultTemplateForUnit } = await import('./templateResolve')
    const dflt = await resolveDefaultTemplateForUnit(unitId)
    if (dflt?.id) wanted.unshift({ templateId: dflt.id, purpose: 'lease' })
  }
  for (const o of (view.other ?? []) as any[]) {
    if (o.purpose === 'lease' || o.purpose === 'work_trade_addendum') continue
    if (o.unitType && o.unitType !== unit.unit_type) continue
    if (!wanted.some(w => w.templateId === o.templateId)) {
      wanted.push({ templateId: o.templateId, purpose: o.purpose === 'installment_sale' ? 'installment_sale' : 'state_disclosure' })
    }
  }
  if (!wanted.some(w => w.purpose === 'lease')) {
    return { packageId: null, reason: 'There is no lease template for this kind of unit yet. Upload one under Templates and the packet builds from it.', needsLease: true }
  }
  // The company that runs this state files the package and holds the copies.
  const fileUnder = unit.landlord_id
  const client = await getClient()
  try {
    await client.query('BEGIN')
    const { US_STATE_NAME, UNIT_TYPE_LABEL } = await import('@gam/shared')
    const name = `${(US_STATE_NAME as any)[unit.state] ?? unit.state} — ${(UNIT_TYPE_LABEL as any)[unit.unit_type] ?? unit.unit_type}`
    const pkg = await client.query(
      `INSERT INTO document_packages (landlord_id, name, description, unit_type, is_default, state_code)
       VALUES ($1,$2,$3,$4,true,$5) RETURNING id`,
      [fileUnder, name, 'Built from your filled document slots at the invite.', unit.unit_type, unit.state]).then(r => r.rows[0])
    let order = 0
    const seen = new Set<string>()
    for (const w of wanted) {
      let templateId = w.templateId
      if (!templateId && w.lib) templateId = (await adoptLibraryDocument(client as any, fileUnder, w.lib)).templateId
      if (!templateId || seen.has(templateId)) continue
      seen.add(templateId)
      await client.query(
        `INSERT INTO document_package_items (package_id, template_id, sort_order, renewal_behavior, required)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (package_id, template_id) DO NOTHING`,
        [pkg.id, templateId, order++, w.purpose === 'lease' ? 'with_lease' : 'once_per_tenancy', w.purpose === 'lease'])
    }
    await client.query('COMMIT')
    return { packageId: pkg.id, created: true }
  } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e } finally { client.release() }
}

