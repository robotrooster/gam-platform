/**
 * S642 (Nic): "On confirmed Column FBO account… they gave me access to their
 * sandbox to play around with, but I have not done that yet. Let's take a look
 * at that."
 *
 * READ-ONLY, and deliberately so. GAM's deposit accounting is complete — money
 * is marked gam_escrow, kept out of landlord payouts, accrues interest and now
 * pays it — but no bank has ever been connected. The trust account is a concept
 * the ledger keeps score against.
 *
 * The first integration must be the one that cannot do damage: read the balance
 * and compare it to the on-book liability. If those two ever diverge, that is
 * the single most important fact in the platform, and today nothing would
 * notice. Money movement comes later and only when Nic says so.
 *
 * DORMANT WITHOUT A KEY. Every function returns a "not configured" result when
 * COLUMN_API_KEY is absent, so this ships safely before the sandbox has even
 * been opened and nothing anywhere has to guard against it.
 *
 * WHAT IS ASSUMED, so it can be corrected against their docs rather than
 * guessed at twice: Column authenticates with the API key as HTTP Basic
 * username and an empty password, and exposes bank accounts at
 * GET /bank-accounts with balances in CENTS. Both the base URL and the auth
 * style are env-overridable precisely because I have not run this against a
 * live sandbox — if either is wrong, it is one variable, not a code change.
 */
import { logger } from '../lib/logger'

const BASE = process.env.COLUMN_API_BASE || 'https://api.column.com'
const KEY  = process.env.COLUMN_API_KEY || ''
/** 'basic' (key as username) or 'bearer'. */
const AUTH = (process.env.COLUMN_AUTH_STYLE || 'basic').toLowerCase()

export const columnConfigured = (): boolean => KEY.length > 0

export interface ColumnAccount {
  id:        string
  name:      string | null
  /** Dollars. Column reports cents; converted once, here. */
  available: number
  pending:   number
  locked:    number
  total:     number
}

export interface ColumnBalanceResult {
  configured: boolean
  ok:         boolean
  accounts:   ColumnAccount[]
  total:      number
  error:      string | null
  /** Which environment the key is pointed at, as Column names it. */
  environment: string | null
}

function authHeader(): string {
  return AUTH === 'bearer'
    ? `Bearer ${KEY}`
    : `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`
}

const cents = (v: unknown): number =>
  typeof v === 'number' ? Math.round(v) / 100 : 0

/**
 * Every account the key can see, with balances in dollars.
 *
 * Never throws: a reconciliation screen that 500s tells an operator less than
 * one that says "could not reach Column". The error travels in the result.
 */
export async function columnBalances(): Promise<ColumnBalanceResult> {
  const empty: ColumnBalanceResult = {
    configured: columnConfigured(), ok: false, accounts: [], total: 0,
    error: null, environment: null,
  }
  if (!columnConfigured()) return { ...empty, error: 'COLUMN_API_KEY is not set' }

  try {
    const res = await fetch(`${BASE}/bank-accounts`, {
      headers: { Authorization: authHeader(), Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ...empty, error: `Column responded ${res.status}: ${body.slice(0, 200)}` }
    }
    const json = await res.json() as any
    const list: any[] = Array.isArray(json) ? json : (json.bank_accounts ?? json.data ?? [])
    const accounts: ColumnAccount[] = list.map((a: any) => {
      const bal = a.balances ?? a
      const available = cents(bal.available_amount)
      const pending   = cents(bal.pending_amount)
      const locked    = cents(bal.locked_amount)
      return {
        id:   String(a.id ?? a.bank_account_id ?? ''),
        name: a.description ?? a.nickname ?? a.name ?? null,
        available, pending, locked,
        total: Math.round((available + pending + locked) * 100) / 100,
      }
    })
    return {
      configured: true, ok: true, accounts,
      total: Math.round(accounts.reduce((s, a) => s + a.total, 0) * 100) / 100,
      error: null,
      // Sandbox keys are prefixed distinctly; surfacing it stops anyone
      // reconciling production money against a test balance and believing it.
      environment: KEY.startsWith('test') || KEY.includes('test') ? 'sandbox' : 'live',
    }
  } catch (e: any) {
    logger.error({ err: e }, '[column] balance read failed')
    return { ...empty, error: e?.message ?? 'Could not reach Column' }
  }
}

export interface TrustReconciliation {
  /** What the ledger says GAM owes tenants: principal + accrued interest. */
  onBookLiability: number
  /** What the bank actually holds, when we can see it. */
  bankBalance:     number | null
  /** bank − book. Negative means GAM is SHORT, which is the alarming case. */
  difference:      number | null
  status: 'not_configured' | 'unreachable' | 'balanced' | 'surplus' | 'SHORT'
  environment: string | null
  error: string | null
}

/**
 * The one comparison that matters: is the money actually there?
 *
 * A surplus is untidy. A SHORTFALL means GAM owes tenants more than it holds,
 * which is the failure the segregated-trust model exists to make impossible —
 * so it is named in capitals rather than shown as a negative number someone has
 * to notice.
 *
 * @param onBookLiability from /admin/deposit-trust/summary — principal plus
 *        accrued interest on every deposit held in escrow.
 */
export async function reconcileTrust(onBookLiability: number): Promise<TrustReconciliation> {
  const bal = await columnBalances()
  if (!bal.configured) {
    return { onBookLiability, bankBalance: null, difference: null,
             status: 'not_configured', environment: null, error: bal.error }
  }
  if (!bal.ok) {
    return { onBookLiability, bankBalance: null, difference: null,
             status: 'unreachable', environment: null, error: bal.error }
  }
  const difference = Math.round((bal.total - onBookLiability) * 100) / 100
  // A cent of float either way is rounding, not a discrepancy.
  const status = Math.abs(difference) < 0.01 ? 'balanced'
               : difference < 0 ? 'SHORT' : 'surplus'
  return {
    onBookLiability,
    bankBalance: bal.total,
    difference,
    status,
    environment: bal.environment,
    error: null,
  }
}
