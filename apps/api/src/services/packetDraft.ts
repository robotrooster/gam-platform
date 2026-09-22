/**
 * S652 — WHAT RIDES WITH A DRAFTED LEASE: THE PACKAGE, AND A SALE IF THERE IS ONE.
 *
 * Nic: "no selecting package/templates at invite." The unit's default package
 * decides what travels with the lease; the only thing a landlord says is
 * whether they are selling this household the home on installments, and that
 * is asked on the invite (only for a park-owned home) and carried here as
 * `homeSale`. Both drafting engines — the invite/accept one and the
 * draft-household one — call this, so a packet is the same packet whichever
 * door it came through.
 *
 * A sale is never papered without its contract: if the terms are given, the
 * home_sale_contracts row is written here, the installment contract is
 * pre-filled from it, and the two are linked — the same rule the e-sign page
 * enforces, because a signed agreement that bills nothing is found months
 * later by somebody wondering where the money is.
 */
import { AppError } from '../middleware/errorHandler'
import { resolvePackageForUnit } from './signingPackages'
import { createHomeSaleContract, homeSaleTermsSchema } from './homeSale'
import crypto from 'crypto'

type Client = { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }

export async function draftPacketSiblings(
  client: Client,
  args: {
    landlordId: string
    unitId: string
    leaseDocId: string
    leaseTemplateId: string
    signers: Array<{ userId: string; role: string; name: string; email: string; phone?: string | null; orderIndex: number }>
    homeSale?: any | null
    prefill?: Record<string, string>
    /** S652: what the landlord left ticked on the invite; null = the package's own suggestion. */
    templateIds?: string[] | null
  },
  createDocumentRecord: (client: any, opts: any) => Promise<any>,
): Promise<{ count: number; groupId: string | null; homeSaleContractId: string | null }> {
  const { landlordId, unitId, leaseDocId, leaseTemplateId, signers } = args

  // The sale first, so the package reads the unit as a sale.
  let sale: any = null
  let salePrefill: Record<string, string> = {}
  if (args.homeSale) {
    const terms = homeSaleTermsSchema.parse(args.homeSale)
    const primary = signers.find(s => s.role === 'primary')
    const buyer = primary ? await client.query(`SELECT id FROM tenants WHERE user_id=$1`, [primary.userId]).then(r => r.rows[0]) : null
    if (!buyer) throw new AppError(400, 'A home sale needs a primary resident to be the buyer.')
    sale = await createHomeSaleContract(client as any, {
      unitId, leaseId: null, tenantId: buyer.id, landlordId,
      salePrice: terms.salePrice, downPayment: terms.downPayment, annualInterestRate: terms.annualInterestRate,
      termMonths: terms.termMonths, startMonth: terms.startMonth, planType: terms.planType, pendingSignature: true,
    })
    salePrefill = {
      sale_price:               Number(terms.salePrice).toFixed(2),
      sale_down_payment:        Number(terms.downPayment).toFixed(2),
      sale_financed_amount:     Number(sale.financed_amount).toFixed(2),
      sale_monthly_payment:     Number(sale.monthly_payment).toFixed(2),
      sale_term_months:         String(terms.termMonths),
      sale_interest_rate:       String(terms.annualInterestRate),
      sale_first_payment_month: String(terms.startMonth),
    }
  }

  const pkg = await resolvePackageForUnit({ landlordIds: [landlordId], unitId, kind: sale ? 'sale' : undefined })
  const ticked = args.templateIds ? new Set(args.templateIds) : null
  const extras = (pkg?.items ?? []).filter(i =>
    (ticked ? ticked.has(i.templateId) : i.suggested) && i.templateId !== leaseTemplateId && i.purpose !== 'lease')
  if (sale && !extras.some(i => i.purpose === 'installment_sale')) {
    throw new AppError(400, 'This household is buying the home, but the package has no installment contract to sign. Add one to the package first.')
  }
  if (!pkg || !extras.length) return { count: 0, groupId: null, homeSaleContractId: sale?.id ?? null }

  const groupId = crypto.randomUUID()
  await client.query(
    `UPDATE lease_documents SET package_group_id=$1, package_id=$2, package_sort_order=0 WHERE id=$3`,
    [groupId, pkg.packageId, leaseDocId])
  let order = 1, count = 0, saleDocId: string | null = null
  for (const i of extras) {
    const t = await client.query(
      `SELECT id, name, base_pdf_url, purpose, version FROM lease_templates
        WHERE id=$1 AND landlord_id = ANY(SELECT account_companies($2)) AND is_active`,
      [i.templateId, landlordId]).then(r => r.rows[0])
    if (!t?.base_pdf_url) continue
    const isSale = t.purpose === 'installment_sale'
    const doc = await createDocumentRecord(client, {
      landlordId, templateId: t.id, unitId, leaseId: null, title: t.name,
      basePdfUrl: t.base_pdf_url, documentType: isSale ? 'purchase_agreement' : 'addendum_terms',
      targetLeaseTenantId: null, promoteLeaseTenantId: null, signers,
      prefillValues: isSale ? { ...(args.prefill ?? {}), ...salePrefill } : (args.prefill ?? {}),
      packageGroupId: groupId, packageId: pkg.packageId, packageSortOrder: order++,
      templateVersion: Number(t.version) || 1,
    })
    if (isSale) saleDocId = doc.id
    count++
  }
  if (sale && saleDocId) {
    await client.query(`UPDATE home_sale_contracts SET purchase_document_id=$2, updated_at=NOW() WHERE id=$1`, [sale.id, saleDocId])
  }
  return { count, groupId, homeSaleContractId: sale?.id ?? null }
}
