/**
 * 10/15 (Nic) — NO CREDIT SITTING ON AN ACCOUNT WHILE THAT HOUSEHOLD OWES.
 *
 *   "If somebody has an outstanding balance, why would they be able to add
 *    credit for future bills? Money gets applied to the most outstanding
 *    balance first. Somebody can't go put $1,000 credit and not pay a $2,000
 *    existing bill. It doesn't work like that." Asked for: "Yes, audit and
 *    block it."
 *
 * The live rule now does this by itself for every kind of credit — money paid
 * ahead, credit the landlord gave, deposit interest — oldest bill first, part
 * of a line where it runs out (creditUse.drawCreditOnBalance). Until 10/15 it
 * did it only for money paid ahead, so a credit the landlord gave could sit
 * beside an open bill it could have paid. This script is the one-time sweep of
 * what is already on the books:
 *
 *   1. It LISTS every household (a person with one company) holding credit
 *      while they owe a bill that credit may pay — name, space, company, credit
 *      held, still owed. The rule is platform-wide, so every company on the
 *      books is covered, and each line names the company whose money moves.
 *      "Owes" is the household's own open bills with that company
 *      that credit is allowed to pay (rent, utilities, late fees, fees on the
 *      credit's own lease). Never counted: a home payment or a GAM fee (credit
 *      never pays either), a work-trade-held bill (labor is paying it), a
 *      carried-forward old balance (it is paid last, from what is over), and a
 *      space in eviction hold.
 *   2. It then runs the live rule for each one (creditUse.settleWholeBillIfCovered
 *      — the whole bill it covers, then the balance draw), which is exactly
 *      what the next bill run would do. No email goes out, no admin alert is
 *      written (alerts: false), and nothing is invented: the money lands where
 *      the one credit service puts it.
 *
 * Paid-ahead money pays only its own space's bills (the credit ledger's rule),
 * so a household owing on a space whose credit sits on ANOTHER space is listed
 * with that said — the sweep cannot move it, and moving money between spaces
 * is Nic's call.
 *
 * Read-only unless told otherwise: everything runs in one transaction that is
 * rolled back. --apply commits. Idempotent — run it twice and the second run
 * finds nothing.
 *   cd apps/api && npx ts-node -T src/scripts/oct18_credit_never_sits_while_owing.ts
 *   cd apps/api && npx ts-node -T src/scripts/oct18_credit_never_sits_while_owing.ts --apply
 */
import type { PoolClient } from 'pg'
import { creditEligibleRowSql } from '../services/moneyPredicates'
import { householdQuote, settleWholeBillIfCovered, type HouseholdQuote } from '../services/creditUse'

const toCents = (v: number | string | null | undefined): number => Math.round(Number(v ?? 0) * 100)
const toDollars = (c: number): number => Math.round(c) / 100
const money = (c: number): string => `$${toDollars(c).toFixed(2)}`

export interface SittingCredit {
  tenantId: string
  landlordId: string
  name: string
  /**
   * The company the household holds this credit with, by name. Review fix
   * (10/17): the rule is platform-wide, so the sweep covers every company on
   * the books — the list says which one each household is, so nobody applies it
   * without seeing whose money moves.
   */
  company: string
  /** The spaces this household holds with this company. */
  spaces: string
  creditHeld: number
  owedBefore: number
  creditHeldAfter: number
  owedAfter: number
  /** Rows the sweep paid in full. */
  settledIds: string[]
  /** Credit the sweep could not spend, and why — for Nic, never guessed at. */
  leftSitting: string | null
}

/** What this household owes that credit may pay (cents), credit already on a row off. */
function owedCents(q: HouseholdQuote): number {
  return q.leases.reduce((t, l) => t + l.rows
    .filter(r => r.required && r.creditEligible)
    .reduce((s, r) => s + Math.max(0, toCents(r.amount) - toCents(r.appliedOnRow)), 0), 0)
}

/** Every dollar of credit on the account (cents). */
const creditCents = (q: HouseholdQuote): number =>
  q.credits.reduce((t, c) => t + toCents(c.amountRemaining), 0)

async function nameOf(client: PoolClient, tenantId: string): Promise<string> {
  const r = await client.query<{ n: string | null }>(
    `SELECT NULLIF(btrim(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), '') AS n
       FROM tenants t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = $1`, [tenantId])
  return r.rows[0]?.n ?? tenantId
}

async function companyOf(client: PoolClient, landlordId: string): Promise<string> {
  const r = await client.query<{ n: string | null }>(
    `SELECT NULLIF(btrim(COALESCE(business_name, '')), '') AS n FROM landlords WHERE id = $1`, [landlordId])
  return r.rows[0]?.n ?? landlordId
}

async function spacesOf(client: PoolClient, tenantId: string, landlordId: string): Promise<string> {
  const r = await client.query<{ s: string | null }>(
    `SELECT string_agg(DISTINCT un.unit_number, ', ' ORDER BY un.unit_number) AS s
       FROM lease_tenants lt JOIN leases l ON l.id = lt.lease_id
       LEFT JOIN units un ON un.id = l.unit_id
      WHERE lt.tenant_id = $1 AND l.landlord_id = $2`, [tenantId, landlordId])
  return r.rows[0]?.s ?? '—'
}

/**
 * Households holding credit of any kind with a company they owe. Read first,
 * so the list is what the books said before anything moved.
 */
async function householdsHoldingCredit(client: PoolClient): Promise<Array<{ tenant_id: string; landlord_id: string }>> {
  return (await client.query<{ tenant_id: string; landlord_id: string }>(
    `SELECT tenant_id, landlord_id FROM (
       SELECT tc.tenant_id, tc.landlord_id
         FROM tenant_credits tc
        WHERE tc.status = 'active' AND tc.amount_remaining > 0
       UNION
       SELECT c.tenant_id, l.landlord_id
         FROM lease_prepaid_credits c JOIN leases l ON l.id = c.lease_id
        WHERE c.voided_at IS NULL AND c.amount_remaining > 0
     ) h
      WHERE EXISTS (SELECT 1 FROM payments p
                     WHERE p.landlord_id = h.landlord_id
                       AND ${creditEligibleRowSql('p')}
                       AND (p.tenant_id = h.tenant_id
                            OR EXISTS (SELECT 1 FROM lease_tenants lt
                                        WHERE lt.lease_id = p.lease_id AND lt.tenant_id = h.tenant_id)))
      ORDER BY tenant_id, landlord_id`)).rows
}

export async function sweepCreditSittingWhileOwing(client: PoolClient): Promise<SittingCredit[]> {
  const out: SittingCredit[] = []
  for (const h of await householdsHoldingCredit(client)) {
    const before = await householdQuote(client, {
      tenantId: h.tenant_id, landlordId: h.landlord_id, includeReleasable: false,
    })
    const owedBefore = owedCents(before)
    const heldBefore = creditCents(before)
    if (owedBefore <= 0 || heldBefore <= 0) continue
    const r = await settleWholeBillIfCovered(client, {
      tenantId: h.tenant_id, landlordId: h.landlord_id, source: 'whole_bill', receipt: false, alerts: false,
    })
    const after = await householdQuote(client, {
      tenantId: h.tenant_id, landlordId: h.landlord_id, includeReleasable: false,
    })
    const owedAfter = owedCents(after)
    const heldAfter = creditCents(after)
    out.push({
      tenantId: h.tenant_id, landlordId: h.landlord_id,
      name: await nameOf(client, h.tenant_id),
      company: await companyOf(client, h.landlord_id),
      spaces: await spacesOf(client, h.tenant_id, h.landlord_id),
      creditHeld: toDollars(heldBefore), owedBefore: toDollars(owedBefore),
      creditHeldAfter: toDollars(heldAfter), owedAfter: toDollars(owedAfter),
      settledIds: r.settledIds,
      // Credit still on the account with money still owed: the rule left it
      // alone on purpose and a person has to look. The three reasons it can
      // happen, in Nic's words, are a bank pull already on its way for that
      // bill, rent on a space the stay no longer covers, and money paid ahead
      // on one space while another space is the one that owes.
      leftSitting: heldAfter > 0 && owedAfter > 0
        ? `${money(heldAfter)} of credit is still on the account with ${money(owedAfter)} owed — the credit is on a space that does not owe, or that bill has a bank payment on its way. Look before moving anything.`
        : null,
    })
  }
  return out
}

export function printSweep(rows: readonly SittingCredit[], log: (s: string) => void = console.log): void {
  if (rows.length === 0) {
    log('No household holds credit while owing a bill that credit may pay.')
    return
  }
  log(`${rows.length} household(s) held credit while owing:`)
  for (const r of rows) {
    log(`\n${r.name} — ${r.spaces}, ${r.company} (tenant ${r.tenantId}, company ${r.landlordId})`)
    log(`  credit held ${money(toCents(r.creditHeld))} → ${money(toCents(r.creditHeldAfter))}; ` +
      `owed ${money(toCents(r.owedBefore))} → ${money(toCents(r.owedAfter))}`)
    if (r.settledIds.length) log(`  paid in full: ${r.settledIds.join(', ')}`)
    if (r.leftSitting) log(`  LEFT ALONE — ${r.leftSitting}`)
  }
}

if (require.main === module) {
  ;(async () => {
    const apply = process.argv.includes('--apply')
    const { getClient } = await import('../db')
    const c = await getClient()
    let code = 0
    try {
      await c.query('BEGIN')
      const rows = await sweepCreditSittingWhileOwing(c)
      printSweep(rows)
      if (apply) { await c.query('COMMIT'); console.log('\nCOMMITTED') }
      else { await c.query('ROLLBACK'); console.log('\nDRY RUN — rolled back. --apply to commit.') }
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {})
      console.error(e instanceof Error ? e.message : e)
      code = 1
    } finally {
      c.release()
    }
    process.exit(code)
  })()
}
