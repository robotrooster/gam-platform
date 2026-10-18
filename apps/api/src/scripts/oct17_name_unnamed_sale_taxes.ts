/**
 * 10/17 (Nic) — THE $0.87 OF PROPANE TAX GETS THE NAME OF THE AGENCY IT IS OWED TO
 *
 *   Nic, 10/17: "we collect sales tax on propane for the transaction privilege
 *   tax. Those need to be itemized so we can file that tax to the right
 *   departments and pay that correctly... We're also showing some other
 *   miscellaneous income that I think she said was a weird amount, $13 and
 *   some change. Nothing we have priced comes out that way."
 *
 * WHAT WAS WRONG. The $13 and some change was FOUR GALLONS OF PROPANE AT $3.30
 * = $13.20 — Steven Starr's pay link, paid 9/29, with $0.87 of tax on top
 * ($14.07 charged, plus the $1.04 card fee). The arithmetic was right. Two
 * things were not:
 *
 *   1. The sale never recorded WHICH tax it charged. A pay link only named its
 *      taxes when it carried a reservation (routes/posPayLinks), so a link for
 *      goods alone wrote its tax with no names on it.
 *   2. With no names on the sale, GAM Books had nothing to post against, so its
 *      projector put that $0.87 on the GENERIC "Sales tax payable" (2040)
 *      instead of the named "Sales tax payable: Transaction privilege tax"
 *      (2040-1) every counter sale lands on. Mountain View's two agencies'
 *      buckets therefore did not add up: 2040-1 held $20.66, 2042 "Lodging tax
 *      payable" held $17.08, and a stray $0.87 sat in 2040 with no agency.
 *
 * (1) is fixed in the code: routes/posPayLinks now names a goods link's taxes
 * from its own lines when the sale is written, so NO NEW SALE can land in the
 * generic account.
 *
 * (2) is what this script fixes, for the sales already written. IT DOES NOT
 * TOUCH A POSTED LEDGER LINE, and it writes no correcting journal entry. The
 * books are not a place where figures are edited — every posting is derived
 * from the money rows (design §4, §8), and a rebuild re-derives it. So a
 * hand-moved line would be moved back by the next rebuild, and a correcting
 * journal would leave the generic account holding a credit and an offsetting
 * debit forever while the sale itself still read "tax, unnamed" on every
 * screen. Instead this RESTORES THE MISSING FACT on the sale — the names of
 * the taxes it charged, resolved from its own lines against the company's own
 * tax rates, scaled so they add up to the tax the customer actually paid (the
 * amount is never re-priced). The capture trigger on pos_transactions then
 * marks the sale for posting again by itself, and within the minute the engine
 * supersedes the old posting (a reversal, then a new post) and the $0.87 lands
 * on 2040-1 where the agency's money belongs. A rebuild tomorrow comes out the
 * same, because the fact is now stored.
 *
 * IT NAMES A TAX ONLY WHEN IT IS SURE WHICH TAX IT WAS. A wrong name on an
 * agency's money is worse than no name, so a sale is REPORTED and left alone
 * when any of these is true, and the breakdown page keeps showing it by name as
 * a tax with no agency so it is never silently filed:
 *
 *   - nothing in the catalog resolves, or only the item's own bare rate, which
 *     names no agency;
 *   - the tax the company's rates would charge those lines TODAY is not the tax
 *     the sale actually charged (a rate created or changed since would take a
 *     share of money never charged for it);
 *   - the sale paid toward a STAY, whose lodging tax is priced off the
 *     property's own percentage and not the catalog at all — production holds a
 *     lodging line charged at 6.35% beside a named rate of 6.6%, so the catalog
 *     cannot say how much of a mixed sale's tax is the town's.
 *
 * Nic's two companies only (OAK_PARK, MOUNTAIN_VIEW below). Idempotent: a sale
 * that already records its taxes is not a candidate, so a second run finds
 * nothing to do.
 *
 * DRY RUN BY DEFAULT — read-only (it reads production and writes nothing; it
 * can run with default_transaction_read_only on). --apply writes in one
 * transaction.
 *   cd apps/api && npx ts-node -T src/scripts/oct17_name_unnamed_sale_taxes.ts
 *   cd apps/api && npx ts-node -T src/scripts/oct17_name_unnamed_sale_taxes.ts --apply
 */
import type { PoolClient } from 'pg'
import {
  BARE_ITEM_RATE_NAME, PLACEHOLDER_TAX_NAME, isNamedAgencyTax, scaleNamedTaxes, type NamedSaleTax,
} from '@gam/shared'
import { getClient } from '../db'

/** Nic's two companies, as production has them (read 10/17). */
export const NAME_TAX_COMPANIES = [
  { landlordId: '8d59242e-c1e5-48a7-b768-420c57fb5fca', name: 'Oak Park Motel and RV LLC' },
  { landlordId: '96ec7df3-362d-4777-b54c-e9604313820f', name: 'Mountain View RV Park Ranch LLC' },
] as const

// The two names that are not an agency's (@gam/shared isNamedAgencyTax): the
// item's own bare rate, and the placeholder routes/pos writes when nothing of
// the company's resolved. Neither is ever written onto a sale — the sale is
// reported instead. Re-exported here because this script's words print them.
export { BARE_ITEM_RATE_NAME, PLACEHOLDER_TAX_NAME }

export interface UnnamedSale {
  saleId: string
  landlordId: string
  company: string
  property: string | null
  day: string
  method: string
  subtotal: string
  taxAmount: string
  viaPayLink: boolean
  /** What it sold, in words ("Propane × 4 @ $3.30"). */
  lines: string[]
  /** The account its tax sits on today, as the books have it. */
  accountNow: string | null
  /** The names GAM can give its taxes (empty: it cannot name them). */
  named: NamedSaleTax[]
  /** Why it is left alone, when it is. */
  skipped: string | null
}

export interface NameTaxPlan {
  sales: UnnamedSale[]
  /** The ones --apply would write. */
  writable: UnnamedSale[]
}

/** Read-only: every sale of these companies that charged tax and never said which. */
export async function planNameUnnamedSaleTaxes(
  client: Pick<PoolClient, 'query'>,
  companies: readonly { landlordId: string; name: string }[] = NAME_TAX_COMPANIES,
): Promise<NameTaxPlan> {
  const byId = new Map(companies.map(c => [c.landlordId, c.name]))
  const rows = (await client.query<{
    id: string; landlord_id: string; property: string | null; day: string; method: string
    subtotal: string; tax_amount: string; via_pay_link: boolean; account_now: string | null; paid_a_stay: boolean
  }>(
    `SELECT t.id, t.landlord_id, p.name AS property,
            to_char((t.created_at AT TIME ZONE COALESCE(p.timezone, 'America/Phoenix'))::date, 'YYYY-MM-DD') AS day,
            t.payment_method AS method, t.subtotal::text, t.tax_amount::text,
            (t.pay_link_id IS NOT NULL) AS via_pay_link,
            (SELECT a.code || ' ' || a.name
               FROM ledger_posting_lines l
               JOIN ledger_postings ps ON ps.id = l.posting_id
               JOIN books_accounts a ON a.id = l.account_id
              WHERE ps.source_type = 'pos_sale' AND ps.source_id = t.id::text
                AND ps.role = 'post' AND ps.superseded_at IS NULL
                AND l.account_role IN ('sales_tax_payable', 'lodging_tax_payable')
              ORDER BY a.code LIMIT 1) AS account_now,
            EXISTS (SELECT 1 FROM stay_payments sp WHERE sp.pos_transaction_id = t.id) AS paid_a_stay
       FROM pos_transactions t
       LEFT JOIN properties p ON p.id = t.property_id
      WHERE t.landlord_id = ANY($1::uuid[])
        AND t.tax_amount > 0
        AND t.status <> 'voided' AND t.voided_at IS NULL
        AND (t.tax_breakdown IS NULL
             OR jsonb_typeof(t.tax_breakdown) <> 'array'
             OR jsonb_array_length(t.tax_breakdown) = 0)
      ORDER BY t.created_at`,
    [companies.map(c => c.landlordId)])).rows

  const sales: UnnamedSale[] = []
  for (const r of rows) {
    const lines = (await client.query<{ name: string; qty: string; price: string; subtotal: string; item_id: string | null }>(
      `SELECT i.item_name AS name, i.qty::text, i.unit_price::text AS price, i.subtotal::text, i.item_id::text
         FROM pos_transaction_items i WHERE i.transaction_id = $1 ORDER BY i.created_at, i.id`, [r.id])).rows
    const words = lines.map(l => `${l.name} × ${trimQty(l.qty)} @ $${Number(l.price).toFixed(2)} = $${Number(l.subtotal).toFixed(2)}`)
    // 10/17 (review): a sale that paid a stay is never named here. A stay's
    // lodging tax is priced off the PROPERTY's own percentage, not
    // pos_tax_rates, so the catalog cannot resolve it and whatever did resolve
    // would be made to absorb the lodging tax too — the town's money under the
    // state's name. Left alone and reported.
    const { named, why } = r.paid_a_stay === true
      ? { named: [] as NamedSaleTax[], why: 'it paid toward a stay, and a stay\'s lodging tax is priced off the property, not the catalog — GAM cannot tell how much of this tax is the town\'s' }
      : await nameTheTaxes(r.landlord_id, lines, Number(r.tax_amount))
    const skipped = named.length ? null : why ?? 'GAM cannot resolve a named tax for it'
    sales.push({
      saleId: r.id, landlordId: r.landlord_id, company: byId.get(r.landlord_id) ?? r.landlord_id,
      property: r.property, day: r.day, method: r.method, subtotal: r.subtotal, taxAmount: r.tax_amount,
      viaPayLink: r.via_pay_link === true, lines: words, accountNow: r.account_now, named, skipped,
    })
  }
  return { sales, writable: sales.filter(s => !s.skipped && s.named.length > 0) }
}

/** '4.000' → '4', '4.600' → '4.6' */
function trimQty(q: string): string {
  const n = Number(q)
  return isFinite(n) ? String(Math.round(n * 1000) / 1000) : q
}

/** How far the tax today's rates compute may sit from the tax the sale charged: a cent. */
const AGREES_WITHIN = 0.01

/**
 * The names of the taxes a sale charged, resolved from its own lines through
 * the company's own rates — the SAME resolution the counter uses when it writes
 * a sale (routes/pos cartTaxBreakdown). Empty when nothing can be named, with
 * the reason.
 *
 * 10/17 (review): THE RESOLVED TAX MUST AGREE WITH THE TAX THE SALE CHARGED,
 * to the cent, before a name is written. Scaling whatever resolved up to the
 * sale's own tax_amount without that check is how one agency's money ends up
 * under another agency's name: a rate created or changed since the sale would
 * take a share of money never charged for it, and a sale whose tax was partly a
 * stay's lodging tax (priced off the property's own percentage, not
 * pos_tax_rates — production holds a lodging line charged at 6.35% while the
 * named rate reads 6.6%) would have ALL of it stamped as the good's tax. When
 * the two disagree, GAM does not know which tax the money was, so it says so
 * and leaves the sale alone. The AMOUNT written is always the tax the sale
 * charged (scaleNamedTaxes), so nothing is ever re-priced.
 */
async function nameTheTaxes(
  landlordId: string,
  lines: readonly { name: string; qty: string; price: string; item_id: string | null }[],
  taxAmount: number,
): Promise<{ named: NamedSaleTax[]; why: string | null }> {
  if (!(taxAmount > 0) || !lines.length) return { named: [], why: 'it has no lines to resolve a named tax from' }
  const { cartTaxBreakdown } = await import('../routes/pos')
  const items = lines.map(l => ({ id: l.item_id, name: l.name, qty: Number(l.qty) || 0, price: Number(l.price) || 0 }))
  let resolved: NamedSaleTax[]
  try {
    resolved = await cartTaxBreakdown(landlordId, items)
  } catch {
    // An item that is no longer the company's (removed from the catalog): the
    // cart cannot be verified, so nothing is named.
    return { named: [], why: 'one of its items is no longer in the catalog, so what it was taxed cannot be verified' }
  }
  const real = resolved.filter(isNamedAgencyTax)
  if (!real.length) {
    return {
      named: [],
      why: lines.some(l => l.item_id)
        ? 'the company\'s tax rates name no tax for what it sold — only the item\'s own bare rate, which names no agency'
        : 'none of its lines is a catalog item, so there is nothing to resolve a named tax from',
    }
  }
  const computed = round2(real.reduce((a, t) => a + Number(t.amount), 0))
  if (Math.abs(computed - round2(taxAmount)) > AGREES_WITHIN) {
    return {
      named: [],
      why: `the company's rates today would charge $${computed.toFixed(2)} of tax on these lines, but the sale charged `
        + `$${round2(taxAmount).toFixed(2)} — GAM cannot tell which tax the difference belongs to, so naming it could send `
        + 'one agency\'s money to another',
    }
  }
  return { named: scaleNamedTaxes(real, taxAmount), why: null }
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

/** Inside the caller's transaction: writes the names onto each sale it can name. Returns how many. */
export async function applyNameUnnamedSaleTaxes(client: Pick<PoolClient, 'query'>, plan: NameTaxPlan): Promise<number> {
  let written = 0
  for (const s of plan.writable) {
    // Idempotent and safe under a race: only a sale that STILL records nothing,
    // and still charges the tax the plan was built on, is written.
    const r = await client.query(
      `UPDATE pos_transactions
          SET tax_breakdown = $2::jsonb
        WHERE id = $1
          AND tax_amount = $3::numeric
          AND status <> 'voided' AND voided_at IS NULL
          AND (tax_breakdown IS NULL
               OR jsonb_typeof(tax_breakdown) <> 'array'
               OR jsonb_array_length(tax_breakdown) = 0)`,
      [s.saleId, JSON.stringify(s.named), s.taxAmount])
    written += r.rowCount ?? 0
  }
  return written
}

function words(plan: NameTaxPlan): string[] {
  if (!plan.sales.length) return ['  Nothing to do: every sale that charged tax already records which tax it was.']
  const out: string[] = []
  for (const s of plan.sales) {
    out.push(`  ${s.day}  ${s.company}${s.property ? ` — ${s.property}` : ''}  sale ${s.saleId}`)
    out.push(`    ${s.method}${s.viaPayLink ? ' on a pay link' : ' at the counter'}: $${Number(s.subtotal).toFixed(2)} of goods, $${Number(s.taxAmount).toFixed(2)} of tax.`)
    for (const l of s.lines) out.push(`      ${l}`)
    out.push(`    The books have that tax on ${s.accountNow ?? 'no account yet (the sale has not posted)'}.`)
    if (s.skipped) {
      out.push(`    LEFT ALONE: ${s.skipped}. It stays on the breakdown page as a tax with no name, to be settled by hand.`)
    } else {
      for (const t of s.named) {
        out.push(`    Would record: "${t.name}" at ${(t.rate * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}% = $${t.amount.toFixed(2)}.`)
      }
      out.push('    The sale is then marked for posting again by its own capture trigger; within the minute the books take the')
      out.push('    old posting back and post it again with that tax on its named account. No money changes: the customer paid')
      out.push(`    $${Number(s.taxAmount).toFixed(2)} of tax and still has.`)
    }
  }
  out.push(`  ${plan.writable.length} of ${plan.sales.length} can be named.`)
  return out
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const c = await getClient()
  try {
    if (!apply) {
      const plan = await planNameUnnamedSaleTaxes(c)
      console.log('DRY RUN (read-only)')
      for (const w of words(plan)) console.log(w)
      console.log('Nothing written. Re-run with --apply to write.')
      return
    }
    await c.query('BEGIN')
    const plan = await planNameUnnamedSaleTaxes(c)
    console.log('APPLY')
    for (const w of words(plan)) console.log(w)
    if (!plan.writable.length) { await c.query('ROLLBACK'); return }
    const written = await applyNameUnnamedSaleTaxes(c, plan)
    await c.query('COMMIT')
    console.log(`Committed: ${written} sale${written === 1 ? '' : 's'} now record which tax they charged. The books re-post them within the minute.`)
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
}
