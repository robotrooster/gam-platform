/**
 * S641 — packages of documents a tenant signs in one sitting.
 *
 * Nic: "here's my package for park owned homes in Arizona. Here's my package
 * for tenant owned homes in Arizona. Here's my package for RV spots in
 * Arizona."
 *
 * Packages live at the LANDLORD and are bound to a unit type, deliberately not
 * to a property: "if I buy another RV park in Arizona where the rules are the
 * same, my Arizona RV package could be used at that other property as well.
 * Whereas if you have it locked at the property level and you have different
 * unit types at the same property, it may try to send somebody the wrong
 * package for their unit type."
 */
import { Router } from 'express'
import { z } from 'zod'
import { query, queryOne } from '../db'
import { requireAuth, requirePerm } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'
import { fileUnderCompany, landlordScopeIds } from '../lib/landlordScope'
import { RENEWAL_BEHAVIORS, UNIT_TYPES } from '@gam/shared'
import {
  resolvePackageForUnit, setTemplateProperties, templatePropertyIds,
} from '../services/signingPackages'

export const signingPackagesRouter = Router()
signingPackagesRouter.use(requireAuth)

const itemSchema = z.object({
  templateId: z.string().uuid(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  renewalBehavior: z.enum(RENEWAL_BEHAVIORS as unknown as [string, ...string[]]).optional(),
  required: z.boolean().optional(),
})

const packageSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullable().optional(),
  unitType: z.enum(UNIT_TYPES as unknown as [string, ...string[]]).nullable().optional(),
  // S652: "my Arizona RV package" — the state is half of what lets a package
  // fill itself from the landlord's filled document sleeves.
  stateCode: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
  isDefault: z.boolean().optional(),
  items: z.array(itemSchema).max(40).optional(),
  landlordId: z.string().uuid().optional(),
})

/** Every package the landlord has, with its items. */
signingPackagesRouter.get('/', requirePerm('leases.create'), async (req, res, next) => {
  try {
    const rows = await query<any>(`
      SELECT p.*,
             COALESCE(json_agg(
               json_build_object(
                 'itemId', i.id, 'templateId', i.template_id, 'templateName', t.name,
                 'purpose', t.purpose, 'version', t.version,
                 'sortOrder', i.sort_order, 'renewalBehavior', i.renewal_behavior,
                 'required', i.required
               ) ORDER BY i.sort_order, t.name
             ) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
        FROM document_packages p
        LEFT JOIN document_package_items i ON i.package_id = p.id
        LEFT JOIN lease_templates t ON t.id = i.template_id
       WHERE p.landlord_id = ANY($1::uuid[]) AND p.archived_at IS NULL
       GROUP BY p.id
       ORDER BY p.unit_type NULLS FIRST, p.name`,
      [landlordScopeIds(req.user!)])
    res.json({ success: true, data: rows })
  } catch (e) { next(e) }
})

/** Create a package and its item list in one call. */
signingPackagesRouter.post('/', requirePerm('esign.template_manage'), async (req, res, next) => {
  try {
    const body = packageSchema.parse(req.body)
    // S652: an account that runs two companies (Blu: Country Acres in Illinois,
    // Oak Park in Arizona) was refused with "choose which company" and no way
    // to choose. The package's state already says which: only one of them runs
    // property there.
    // S652: a package is the ACCOUNT's (Nic: "doesn't matter what company it's
    // for"). landlord_id only records where it is filed.
    const landlordId = await fileUnderCompany(req.user!, { explicit: body.landlordId, state: body.stateCode }, query)

    const pkg = await queryOne<{ id: string }>(
      `INSERT INTO document_packages (landlord_id, name, description, unit_type, is_default, state_code)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [landlordId, body.name, body.description ?? null, body.unitType ?? null, body.isDefault ?? false, body.stateCode ?? null])

    await replaceItems(pkg!.id, landlordId, body.items ?? [], req.user!)
    res.status(201).json({ success: true, data: { id: pkg!.id } })
  } catch (e) { next(e) }
})

signingPackagesRouter.put('/:id', requirePerm('esign.template_manage'), async (req, res, next) => {
  try {
    const body = packageSchema.parse(req.body)
    const existing = await queryOne<{ id: string; landlord_id: string }>(
      `SELECT id, landlord_id FROM document_packages
        WHERE id = $1 AND landlord_id = ANY($2::uuid[]) AND archived_at IS NULL`,
      [req.params.id, landlordScopeIds(req.user!)])
    if (!existing) throw new AppError(404, 'Package not found')

    await query(
      `UPDATE document_packages
          SET name=$2, description=$3, unit_type=$4, is_default=$5, state_code=$6, updated_at=now()
        WHERE id=$1`,
      [existing.id, body.name, body.description ?? null, body.unitType ?? null, body.isDefault ?? false, body.stateCode ?? null])

    if (body.items) await replaceItems(existing.id, existing.landlord_id, body.items, req.user!)
    res.json({ success: true, data: { id: existing.id } })
  } catch (e) { next(e) }
})

/**
 * Archive, never delete. A package that assembled somebody's signed bundle is
 * part of how that bundle came to exist.
 */
signingPackagesRouter.delete('/:id', requirePerm('esign.template_manage'), async (req, res, next) => {
  try {
    const row = await queryOne<{ id: string }>(
      `UPDATE document_packages SET archived_at = now(), is_default = FALSE
        WHERE id = $1 AND landlord_id = ANY($2::uuid[]) AND archived_at IS NULL
        RETURNING id`,
      [req.params.id, landlordScopeIds(req.user!)])
    if (!row) throw new AppError(404, 'Package not found')
    res.json({ success: true, data: row })
  } catch (e) { next(e) }
})

/**
 * What would be drafted for this unit — the checklist the landlord sees, with
 * items pre-ticked. Nothing here blocks: an item that does not apply is simply
 * unticked and can be ticked anyway.
 */
signingPackagesRouter.get('/for-unit/:unitId', requirePerm('leases.create'), async (req, res, next) => {
  try {
    const unit = await queryOne<{ landlord_id: string }>(
      `SELECT u.landlord_id FROM units u
        WHERE u.id = $1 AND u.landlord_id = ANY($2::uuid[])`,
      [req.params.unitId, landlordScopeIds(req.user!)])
    if (!unit) throw new AppError(404, 'Unit not found')

    const resolved = await resolvePackageForUnit({
      landlordIds: landlordScopeIds(req.user!),
      unitId: req.params.unitId,
      packageId: typeof req.query.packageId === 'string' ? req.query.packageId : null,
    })
    res.json({ success: true, data: resolved })
  } catch (e) { next(e) }
})

/**
 * Which properties a template is pinned to. No rows means everywhere —
 * the statement of policy, lead paint, a bed bug disclosure.
 */
signingPackagesRouter.get('/templates/:templateId/properties', requirePerm('leases.create'), async (req, res, next) => {
  try {
    await assertTemplateInScope(req.params.templateId, req.user!)
    res.json({ success: true, data: await templatePropertyIds(req.params.templateId) })
  } catch (e) { next(e) }
})

/**
 * Pin a template to any number of properties. Nic: "if I have parking rules at
 * two of my properties and not at a third, I don't wanna have to upload it two
 * times." An empty list unpins it back to available-everywhere.
 */
signingPackagesRouter.put('/templates/:templateId/properties', requirePerm('esign.template_manage'), async (req, res, next) => {
  try {
    await assertTemplateInScope(req.params.templateId, req.user!)
    const body = z.object({ propertyIds: z.array(z.string().uuid()).max(200) }).parse(req.body)

    // Body-supplied ids are ownership-checked before use: a pin must not reach
    // a property this account does not hold.
    if (body.propertyIds.length) {
      const owned = await query<{ id: string }>(
        `SELECT id FROM properties WHERE id = ANY($1::uuid[]) AND landlord_id = ANY($2::uuid[])`,
        [body.propertyIds, landlordScopeIds(req.user!)])
      if (owned.length !== new Set(body.propertyIds).size) {
        throw new AppError(403, 'One of those properties is not yours')
      }
    }

    await setTemplateProperties(req.params.templateId, body.propertyIds)
    res.json({ success: true, data: { propertyIds: body.propertyIds } })
  } catch (e) { next(e) }
})

async function assertTemplateInScope(templateId: string, user: any): Promise<void> {
  const t = await queryOne<{ id: string }>(
    `SELECT id FROM lease_templates WHERE id = $1 AND landlord_id = ANY($2::uuid[])`,
    [templateId, landlordScopeIds(user)])
  if (!t) throw new AppError(404, 'Template not found')
}

/**
 * Full replace of the item list — the editor sends the surviving set, so
 * removing one in the UI removes it here. Templates are verified against the
 * same landlord: a package must not reach for somebody else's form.
 */
async function replaceItems(
  packageId: string,
  _landlordId: string,
  items: Array<z.infer<typeof itemSchema>>,
  user: Parameters<typeof landlordScopeIds>[0],
): Promise<void> {
  if (items.length) {
    // Any document within this account — whichever company it is filed under.
    const ids = [...new Set(items.map(i => i.templateId))]
    const owned = await query<{ id: string }>(
      `SELECT id FROM lease_templates WHERE id = ANY($1::uuid[]) AND landlord_id = ANY($2::uuid[])`,
      [ids, landlordScopeIds(user)])
    if (owned.length !== ids.length) throw new AppError(403, 'One of those documents is not yours')
  }

  await query(`DELETE FROM document_package_items WHERE package_id = $1`, [packageId])
  let order = 0
  for (const it of items) {
    await query(
      `INSERT INTO document_package_items
         (package_id, template_id, sort_order, renewal_behavior, required)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (package_id, template_id) DO NOTHING`,
      [packageId, it.templateId, it.sortOrder ?? order, it.renewalBehavior ?? 'with_lease', it.required ?? false])
    order++
  }
}
