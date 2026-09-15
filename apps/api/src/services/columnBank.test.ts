/**
 * S642 — the Column trust reconciliation.
 *
 * The integration is read-only on purpose: GAM's deposit accounting is complete
 * but no bank was ever connected, so the trust account is a concept the ledger
 * keeps score against. The first thing to wire is the comparison that cannot do
 * damage and would matter most if it ever came out wrong.
 *
 * A SHORTFALL — GAM owing tenants more than it holds — is the failure the whole
 * segregated-trust model exists to prevent. These pin that it is detected and
 * named, and that nothing explodes before a key exists.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => { vi.resetModules() })
afterEach(() => { process.env = { ...ORIGINAL_ENV }; vi.restoreAllMocks() })

/** Load the module fresh so env is read at import time. */
async function load(env: Record<string, string | undefined>) {
  process.env = { ...ORIGINAL_ENV, ...env }
  return await import('./columnBank')
}

describe('S642 Column trust reconciliation', () => {
  it('is dormant without a key — ships safely before the sandbox is opened', async () => {
    const m = await load({ COLUMN_API_KEY: undefined })
    expect(m.columnConfigured()).toBe(false)
    const r = await m.reconcileTrust(5000)
    expect(r.status).toBe('not_configured')
    // The liability is still reported: what GAM owes is knowable without a bank.
    expect(r.onBookLiability).toBe(5000)
    expect(r.bankBalance).toBeNull()
  })

  it('names a SHORTFALL rather than showing a negative number to notice', async () => {
    const m = await load({ COLUMN_API_KEY: 'test_abc' })
    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
      ok: true, json: async () => ([{ id: 'bacct_1', description: 'FBO',
        available_amount: 400000, pending_amount: 0, locked_amount: 0 }]),
    } as any)
    // $4,000 held against $5,000 owed.
    const r = await m.reconcileTrust(5000)
    expect(r.bankBalance).toBe(4000)
    expect(r.difference).toBe(-1000)
    expect(r.status).toBe('SHORT')
  })

  it('reads balances in CENTS and reports dollars', async () => {
    const m = await load({ COLUMN_API_KEY: 'test_abc' })
    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
      ok: true, json: async () => ({ bank_accounts: [
        { id: 'a', available_amount: 123456, pending_amount: 4400, locked_amount: 0 },
      ] }),
    } as any)
    const bal = await m.columnBalances()
    expect(bal.accounts[0].available).toBe(1234.56)
    expect(bal.accounts[0].pending).toBe(44)
    expect(bal.total).toBe(1278.56)
  })

  it('a penny of float is rounding, not a discrepancy', async () => {
    const m = await load({ COLUMN_API_KEY: 'test_abc' })
    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
      ok: true, json: async () => ([{ id: 'a', available_amount: 500000 }]),
    } as any)
    expect((await m.reconcileTrust(5000)).status).toBe('balanced')
  })

  it('surfaces the ENVIRONMENT so sandbox money is never read as real', async () => {
    // Reconciling production liability against a sandbox balance and believing
    // it is the quiet way to think the money is there when it is not.
    const m = await load({ COLUMN_API_KEY: 'test_sandbox_key' })
    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
      ok: true, json: async () => ([{ id: 'a', available_amount: 100 }]),
    } as any)
    expect((await m.reconcileTrust(1)).environment).toBe('sandbox')
  })

  it('an unreachable bank reports itself, it does not throw', async () => {
    // A screen that 500s tells an operator less than one saying "could not
    // reach Column", and a thrown error here would take the whole admin page.
    const m = await load({ COLUMN_API_KEY: 'test_abc' })
    vi.spyOn(globalThis, 'fetch' as any).mockRejectedValue(new Error('ECONNREFUSED'))
    const r = await m.reconcileTrust(5000)
    expect(r.status).toBe('unreachable')
    expect(r.error).toMatch(/ECONNREFUSED/)
    expect(r.onBookLiability).toBe(5000)
  })

  it('a rejected key is reported with its status, not swallowed', async () => {
    const m = await load({ COLUMN_API_KEY: 'bad' })
    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({
      ok: false, status: 401, text: async () => 'unauthorized',
    } as any)
    const r = await m.reconcileTrust(100)
    expect(r.status).toBe('unreachable')
    expect(r.error).toMatch(/401/)
  })
})
