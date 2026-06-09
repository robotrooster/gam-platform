// S241: POS tax calculator. Nic decision: "have tax tables
// configurable so user can do what they want." Cart math now reads
// the live pos_tax_rates table for each item's property + applies
// rates per the table's `applies_to` array.
//
// Per-rate semantics:
//   - rate (decimal, e.g. 0.0825 for 8.25%) applied to line subtotal
//   - applies_to text[]:
//       ['all']                    → applies to every item
//       ['category_name', ...]     → applies only to items in those
//                                    categories (case-insensitive)
//   - is_active = TRUE             → rate is live
//   - property_id                  → the property the rate is bound to
//                                    (NULL means landlord-wide, applies
//                                    to all properties as a fallback)
//
// Multiple rates STACK. A property might have a state rate + a county
// rate + a city rate all active, and each is applied independently to
// the line. The landlord configures rates via the CRUD surface; this
// service is pure math given the configured set.
//
// Returned tax_amount is rounded to cents at the transaction level
// (not per-line, to avoid compounding rounding drift on multi-item
// carts).

import { query, queryOne } from '../db'

export interface PosCartLine {
  /** pos_items.id — required for the lookup; the calc fetches the
   *  current row to verify property + category_id. */
  itemId: string
  /** Whole-number qty. */
  qty: number
  /** Unit sell price in dollars. The landlord might temporarily mark
   *  down an item via cart-level discount; passing the actual price
   *  in lets discounts flow through naturally. */
  unitPrice: number
}

export interface PosTaxBreakdownLine {
  itemId: string
  itemName: string
  categoryName: string | null
  subtotal: number
  appliedRates: {
    rateId: string
    name: string
    rate: number
    amount: number
  }[]
  taxAmount: number
}

export interface PosTaxResult {
  subtotal: number       // sum of all line subtotals (qty * unitPrice)
  taxAmount: number      // sum of all line tax amounts, rounded to cents
  lines: PosTaxBreakdownLine[]
}

/**
 * Compute taxes for a cart against the live pos_tax_rates configuration.
 *
 * Resolves each item's property + category via the items table, then
 * fetches all active rates that apply to that property (property-bound
 * rates + landlord-wide rates as fallback). For each rate, checks if
 * its `applies_to` matches the item's category name (or is `['all']`).
 * Stacks every matching rate on the line subtotal.
 *
 * If any item id can't be resolved to a real pos_items row owned by
 * this landlord, throws — the caller's cart contains a phantom item
 * and we shouldn't ring a sale we can't verify.
 */
export async function calculateCartTax(
  landlordId: string,
  cart: PosCartLine[],
): Promise<PosTaxResult> {
  if (cart.length === 0) {
    return { subtotal: 0, taxAmount: 0, lines: [] }
  }

  // Pull every cart item's row + category name in one query. Then we
  // know each item's property_id and the categories we need to match
  // against.
  const itemIds = cart.map(c => c.itemId)
  const items = await query<{
    id: string
    name: string
    property_id: string
    category_id: string
    category_name: string | null
  }>(
    `SELECT pi.id, pi.name, pi.property_id, pi.category_id, pc.name AS category_name
       FROM pos_items pi
       LEFT JOIN pos_categories pc ON pc.id = pi.category_id
      WHERE pi.id = ANY($1::uuid[]) AND pi.landlord_id = $2`,
    [itemIds, landlordId],
  )
  const byId = new Map(items.map(i => [i.id, i]))
  for (const c of cart) {
    if (!byId.has(c.itemId)) {
      throw new Error(`Cart contains item ${c.itemId} not owned by this landlord`)
    }
  }

  // Collect the set of distinct property_ids touched by this cart.
  // Usually a cart is from one property (one cashier device), but the
  // math doesn't depend on that — each line resolves rates against its
  // own property.
  const propIds = [...new Set(items.map(i => i.property_id))]

  // Fetch all active rates for the touched properties. Property-scoped
  // rates win over landlord-wide ones (NULL property_id) for items on
  // that property — we apply the property-bound set when one exists,
  // and fall back to landlord-wide otherwise. To keep the SQL simple
  // we pull both and resolve at the per-item level below.
  const rates = await query<{
    id: string
    name: string
    rate: string
    applies_to: string[]
    property_id: string | null
  }>(
    `SELECT id, name, rate::text AS rate, applies_to, property_id
       FROM pos_tax_rates
      WHERE landlord_id = $1
        AND is_active = TRUE
        AND (property_id IS NULL OR property_id = ANY($2::uuid[]))`,
    [landlordId, propIds],
  )
  const ratesByProperty = new Map<string | null, typeof rates>()
  for (const r of rates) {
    const key = r.property_id  // null OR uuid string
    if (!ratesByProperty.has(key)) ratesByProperty.set(key, [])
    ratesByProperty.get(key)!.push(r)
  }
  const landlordWideRates = ratesByProperty.get(null) ?? []

  const lines: PosTaxBreakdownLine[] = []
  let subtotalSum = 0
  let taxSum = 0

  for (const c of cart) {
    const item = byId.get(c.itemId)!
    const subtotal = round2(c.qty * c.unitPrice)
    subtotalSum = round2(subtotalSum + subtotal)

    // Property-bound rates for THIS item's property; if none configured,
    // fall back to landlord-wide rates. The fallback is a stacking
    // decision: a landlord with state-level rates that should apply
    // everywhere can set them landlord-wide and not have to attach
    // them to every property.
    const propRates = ratesByProperty.get(item.property_id) ?? []
    const applicableRates = propRates.length > 0 ? propRates : landlordWideRates

    const matchingRates = applicableRates.filter(r =>
      rateAppliesToCategory(r.applies_to, item.category_name))

    const lineAppliedRates: PosTaxBreakdownLine['appliedRates'] = []
    let lineTax = 0
    for (const r of matchingRates) {
      const rateNum = Number(r.rate)
      const amt = round2(subtotal * rateNum)
      lineAppliedRates.push({
        rateId: r.id,
        name:   r.name,
        rate:   rateNum,
        amount: amt,
      })
      lineTax = round2(lineTax + amt)
    }
    taxSum = round2(taxSum + lineTax)

    lines.push({
      itemId: c.itemId,
      itemName: item.name,
      categoryName: item.category_name,
      subtotal,
      appliedRates: lineAppliedRates,
      taxAmount: lineTax,
    })
  }

  return {
    subtotal: subtotalSum,
    taxAmount: round2(taxSum),
    lines,
  }
}

/**
 * Does this rate apply to an item in `categoryName`? Rates with
 * `applies_to = ['all']` match every category; otherwise the category
 * name must be present in the array. Matching is case-insensitive.
 */
function rateAppliesToCategory(
  appliesTo: string[],
  categoryName: string | null,
): boolean {
  if (!appliesTo || appliesTo.length === 0) return false
  const norm = appliesTo.map(s => s.trim().toLowerCase())
  if (norm.includes('all')) return true
  if (!categoryName) return false
  return norm.includes(categoryName.trim().toLowerCase())
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
