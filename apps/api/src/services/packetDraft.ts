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
import { homeSaleTermsSchema } from './homeSale'
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
    /**
     * 10/28 (Nic) — ONE PACKET.
     *
     *   "When Blue sends a takeover packet for the lease and the trailer, the
     *    tenant needs to be able to sign everything at once, not two
     *    workflows, because tenants throw a hissy fit about signing anything in
     *    the first place and trying to get it in two separate steps is going to
     *    be just a headache."
     *
     * The purchase the household is TAKING OVER (not starting). Set, the
     * installment contract rides this same packet with the same signers, so the
     * space and the home are one signing session — and that paper names the
     * contract it assumes, which is what makes the new resident its buyer.
     */
    supersedesHomeSaleContractId?: string | null
  },
  createDocumentRecord: (client: any, opts: any) => Promise<any>,
): Promise<{ count: number; groupId: string | null; homeSaleContractId: string | null }> {
  const { landlordId, unitId, leaseDocId, leaseTemplateId, signers } = args

  // S652 (Nic): the sale terms are TYPED on the installment contract at signing
  // and become the record then — nothing derives from the invite. "Selling
  // them this home" on the invite only says the packet drafts as a sale; any
  // numbers given with it just prefill the boxes for the landlord to type over.
  // A household taking a purchase over signs the same installment contract a
  // new buyer would, so the packet is resolved the same way — what differs is
  // that signing it RETIRES the purchase already on the home (10/28: a takeover
  // is a new contract in every manner, and it supersedes the old one).
  const superseding = !!args.supersedesHomeSaleContractId
  const selling = !!args.homeSale || superseding
  const sale: any = null
  let salePrefill: Record<string, string> = {}
  if (selling && typeof args.homeSale === 'object') {
    const parsed = homeSaleTermsSchema.safeParse(args.homeSale)
    if (parsed.success) {
      const terms = parsed.data
      salePrefill = {
        sale_price:               Number(terms.salePrice).toFixed(2),
        sale_down_payment:        Number(terms.downPayment).toFixed(2),
        sale_term_months:         String(terms.termMonths),
        sale_interest_rate:       String(terms.annualInterestRate),
        sale_first_payment_month: String(terms.startMonth),
        ...(terms.planType === 'flat' && args.homeSale.monthlyAmount != null
          ? { sale_monthly_payment: Number(args.homeSale.monthlyAmount).toFixed(2) } : {}),
      }
    }
  }

  // What the new buyer is taking on, in the boxes: the sale's own price and
  // monthly payment (the terms never change — Nic, 10/23: "the park just wants
  // what it was being sold for in the first place"), the payments actually
  // LEFT, and no down payment, because they are not making one.
  if (superseding) {
    const c = await client.query(
      `SELECT c.monthly_payment, c.annual_interest_rate,
              COALESCE(SUM(i.amount) FILTER (
                WHERE i.payment_id IS NULL AND i.settled_off_platform_at IS NULL), 0) AS still_owed,
              COUNT(i.id) FILTER (
                WHERE i.payment_id IS NULL AND i.settled_off_platform_at IS NULL) AS payments_left
         FROM home_sale_contracts c
         LEFT JOIN home_sale_installments i ON i.contract_id = c.id
        WHERE c.id = $1 AND c.status = 'active'
        GROUP BY c.id`, [args.supersedesHomeSaleContractId]).then(r => r.rows[0])
    if (!c) throw new AppError(400, 'That home purchase is no longer active, so there is nothing to take over.')
    // 10/28 (Nic): "if the landlord wants to keep the same terms, let the person
    // only finish paying what was previously owed. If the landlord wants to do
    // it on a new installment term sale with a different monthly payment on the
    // trailer, that's their choice."
    //
    // So these are a STARTING POINT, not the deal: the boxes come up holding
    // what is actually left on the old contract — the unpaid months and their
    // total — and the landlord types over any of it before signing. Nothing
    // here is read back as the terms; the signed paper is (applySaleTerms-
    // FromDocument), which is what makes the new terms the landlord's choice.
    salePrefill = {
      sale_price:               Number(c.still_owed).toFixed(2),
      sale_down_payment:        '0.00',
      sale_monthly_payment:     Number(c.monthly_payment).toFixed(2),
      sale_term_months:         String(Number(c.payments_left) || 0),
      sale_interest_rate:       String(c.annual_interest_rate ?? 0),
    }
  }

  const pkg = await resolvePackageForUnit({ landlordIds: [landlordId], unitId, kind: selling ? 'sale' : undefined })
  const ticked = args.templateIds ? new Set(args.templateIds) : null
  const extras = (pkg?.items ?? []).filter(i =>
    (ticked ? ticked.has(i.templateId) : i.suggested) && i.templateId !== leaseTemplateId && i.purpose !== 'lease')
  if (selling && !extras.some(i => i.purpose === 'installment_sale')) {
    throw new AppError(400, superseding
      ? 'This household is taking over the home payments, but the package has no installment contract for them to sign. '
        + 'Add one to the package first — without it they would be billed for a trailer they never signed for.'
      : 'This household is buying the home, but the package has no installment contract to sign. Add one to the package first.')
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
      // Only the installment paper hands the purchase over; the lease and the
      // park rules beside it are not a contract assumption.
      ...(isSale && superseding ? { supersedesHomeSaleContractId: args.supersedesHomeSaleContractId } : {}),
    })
    if (isSale) saleDocId = doc.id
    count++
  }
  if (sale && saleDocId) {
    await client.query(`UPDATE home_sale_contracts SET purchase_document_id=$2, updated_at=NOW() WHERE id=$1`, [sale.id, saleDocId])
  }
  return { count, groupId, homeSaleContractId: sale?.id ?? null }
}
