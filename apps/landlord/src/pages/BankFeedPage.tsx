// S570 (Nic): bank feed. Link an operating bank read-only via Stripe Financial
// Connections; GAM auto-matches the money it already knows (rent payouts) and
// surfaces the rest — a $1k Home Depot charge from the landlord's own bank — for
// a 2-click categorize into the P&L. The landlord ALWAYS confirms and ALWAYS
// picks scope (a unit, or the property split/common across units); auto-suggest
// only pre-fills from what this landlord chose for the same merchant before.
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { loadStripe } from '@stripe/stripe-js'
import { apiGet, apiPost } from '../lib/api'
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABEL } from '@gam/shared'
import { toast, appConfirm } from '../components/dialogs'
import { Landmark, RefreshCw, Check, X, Plus } from 'lucide-react'

const STRIPE_PK = (import.meta as any).env?.VITE_STRIPE_PUBLISHABLE_KEY as string | undefined
const stripePromise = STRIPE_PK ? loadStripe(STRIPE_PK) : null

const fmt = (n: any) => {
  const v = Number(n)
  const s = `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return v < 0 ? `− ${s}` : s
}
const fmtDate = (d: any) => (d ? String(d).slice(0, 10) : '—')

const SCOPE_LABEL: Record<string, string> = {
  unit: 'One unit',
  property_common: 'Whole property (common)',
  property_allocate: 'Whole property, split per unit',
}

type Draft = { category: string; scopeKind: string; propertyId: string; unitId: string }

export function BankFeedPage() {
  const qc = useQueryClient()
  const [linking, setLinking] = useState(false)
  const [linkErr, setLinkErr] = useState<string | null>(null)
  const [view, setView] = useState<'needs_review' | 'categorized' | 'ignored'>('needs_review')

  const { data: connections = [] } = useQuery<any[]>('bank-connections', () => apiGet('/bank-feed/connections'))
  const { data: properties = [] } = useQuery<any[]>('properties', () => apiGet('/properties'))
  const { data: units = [] } = useQuery<any[]>('units', () => apiGet('/units'))
  const { data: txns = [], isLoading } = useQuery<any[]>(
    ['bank-txns', view], () => apiGet(`/bank-feed/transactions?status=${view}`))

  const propOf = (u: any) => u.propertyId
  const unitsForProp = (pid: string) => (units as any[]).filter(u => propOf(u) === pid)

  // Per-row categorize draft, pre-seeded from the merchant suggestion.
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const draftFor = (t: any): Draft => drafts[t.id] || {
    category: t.suggestedCategory || 'repairs',
    scopeKind: t.suggestedScopeKind || 'unit',
    propertyId: t.suggestedPropertyId || '',
    unitId: t.suggestedUnitId || '',
  }
  const setDraft = (id: string, patch: Partial<Draft>) => {
    const row = (txns as any[]).find(t => t.id === id) || { id }
    setDrafts(d => ({ ...d, [id]: { ...draftFor(row), ...d[id], ...patch } }))
  }

  const link = async () => {
    setLinkErr(null)
    if (!stripePromise) { setLinkErr('Bank linking is not configured (missing Stripe key).'); return }
    setLinking(true)
    try {
      const stripe = await stripePromise
      if (!stripe) throw new Error('Stripe failed to load')
      const { data: session } = await apiPost('/bank-feed/link-session', {})
      const { clientSecret, sessionId } = session
      const result = await (stripe as any).collectFinancialConnectionsAccounts({ clientSecret })
      if (result.error) throw new Error(result.error.message)
      const accounts = result.financialConnectionsSession?.accounts ?? []
      if (!accounts.length) { setLinking(false); return } // user closed the modal
      await apiPost('/bank-feed/finalize', { sessionId })
      qc.invalidateQueries('bank-connections')
      qc.invalidateQueries(['bank-txns'])
      toast('Bank linked. Syncing transactions…')
    } catch (e: any) {
      setLinkErr(e?.response?.data?.message || e?.message || 'Could not link the bank.')
    } finally {
      setLinking(false)
    }
  }

  const sync = useMutation((id: string) => apiPost(`/bank-feed/connections/${id}/sync`, {}), {
    onSuccess: (d: any) => { qc.invalidateQueries(['bank-txns']); qc.invalidateQueries('bank-connections')
      const n = d?.data?.inserted; toast(n ? `${n} new transaction(s).` : 'Up to date.') },
    onError: (e: any) => toast(e?.response?.data?.message || 'Sync failed.'),
  })

  const disconnect = useMutation((id: string) => apiPost(`/bank-feed/connections/${id}/disconnect`, {}), {
    onSuccess: () => { qc.invalidateQueries('bank-connections'); toast('Bank disconnected.') },
  })

  const categorize = useMutation(
    ({ id, body }: { id: string; body: any }) => apiPost(`/bank-feed/transactions/${id}/categorize`, body), {
    onSuccess: () => { qc.invalidateQueries(['bank-txns']); toast('Categorized → added to your expenses.') },
    onError: (e: any) => toast(e?.response?.data?.message || 'Could not categorize.'),
  })

  const ignore = useMutation((id: string) => apiPost(`/bank-feed/transactions/${id}/ignore`, {}), {
    onSuccess: () => { qc.invalidateQueries(['bank-txns']); toast('Ignored.') },
  })

  const submit = (t: any) => {
    const d = draftFor(t)
    if (d.scopeKind === 'unit' && !d.unitId) { toast('Pick a unit.'); return }
    if (d.scopeKind !== 'unit' && !d.propertyId) { toast('Pick a property.'); return }
    categorize.mutate({ id: t.id, body: {
      category: d.category, scopeKind: d.scopeKind,
      ...(d.scopeKind === 'unit' ? { unitId: d.unitId } : { propertyId: d.propertyId }),
    } })
  }

  const reviewCount = useMemo(() => txns.filter((t: any) => t.status === 'needs_review').length, [txns])

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Bank Feed</h1>
          <p className="page-subtitle">
            Link your operating bank read-only. GAM hides the money it already tracks (rent payouts)
            and surfaces the rest — your own spending — to categorize into your P&L in two clicks.
          </p>
        </div>
        <button className="btn btn-primary" onClick={link} disabled={linking}>
          <Plus size={16} /> {linking ? 'Linking…' : 'Connect a bank'}
        </button>
      </div>
      {linkErr && <div className="card" style={{ borderColor: 'var(--danger)', color: 'var(--danger)', marginBottom: 16 }}>{linkErr}</div>}

      {/* S576 (B-5): signpost the sibling workflow so the two "bank" tabs read as
          distinct jobs — this one CATEGORIZES spend; the other MATCHES a statement. */}
      <div style={{ fontSize: '.76rem', color: 'var(--text-3)', marginBottom: 16, lineHeight: 1.5 }}>
        This is for <strong>categorizing spending</strong> from a linked bank into your P&L.
        To check that a month's deposits match what GAM sent you, use{' '}
        <Link to="/bank-reconciliation" style={{ color: 'var(--gold)', fontWeight: 600 }}>Bank Reconciliation</Link>.
      </div>

      {/* Linked banks */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title" style={{ marginBottom: 12 }}>Linked banks</div>
        {connections.length === 0
          ? <div style={{ color: 'var(--text-3)', fontSize: '.85rem' }}>No banks linked yet. Connect one to start pulling transactions.</div>
          : <div style={{ display: 'grid', gap: 8 }}>
              {connections.map((c: any) => (
                <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <Landmark size={18} style={{ color: 'var(--gold)' }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{c.displayName || c.institutionName}</div>
                    <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
                      {c.lastSyncedAt ? `Last synced ${fmtDate(c.lastSyncedAt)}` : 'Not yet synced'}
                      {c.status === 'error' && c.lastSyncError ? ` · error: ${c.lastSyncError}` : ''}
                    </div>
                  </div>
                  <button className="btn btn-ghost btn-sm" onClick={() => sync.mutate(c.id)} disabled={sync.isLoading}>
                    <RefreshCw size={14} /> Sync
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={async () => {
                    if (await appConfirm('Disconnect this bank? Past transactions stay; no new ones will sync.')) disconnect.mutate(c.id)
                  }}>Disconnect</button>
                </div>
              ))}
            </div>}
      </div>

      {/* Transaction views */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {(['needs_review', 'categorized', 'ignored'] as const).map(v => (
          <button key={v} className={`btn btn-sm ${view === v ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView(v)}>
            {v === 'needs_review' ? `Needs review${reviewCount && view === v ? ` (${reviewCount})` : ''}` : v === 'categorized' ? 'Categorized' : 'Ignored'}
          </button>
        ))}
      </div>

      <div className="card">
        {isLoading ? <div style={{ color: 'var(--text-3)' }}>Loading…</div>
          : txns.length === 0 ? <div style={{ color: 'var(--text-3)', fontSize: '.85rem' }}>
              {view === 'needs_review' ? 'Nothing to review. Sync a linked bank to pull new transactions.' : 'None.'}
            </div>
          : <div style={{ display: 'grid', gap: 10 }}>
              {txns.map((t: any) => {
                const isExpense = Number(t.amount) < 0
                const d = draftFor(t)
                return (
                  <div key={t.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>{t.normalizedMerchant || t.description || 'Transaction'}</div>
                        <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
                          {fmtDate(t.postedDate)} · {t.connectionName}
                          {t.description && t.description !== t.normalizedMerchant ? ` · ${t.description}` : ''}
                        </div>
                      </div>
                      <div style={{ fontWeight: 700, color: isExpense ? 'var(--text-0)' : 'var(--success, #3fb950)' }}>{fmt(t.amount)}</div>
                    </div>

                    {view === 'needs_review' && isExpense && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8, alignItems: 'center' }}>
                        <select className="input input-sm" value={d.category} onChange={e => setDraft(t.id, { category: e.target.value })}>
                          {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{EXPENSE_CATEGORY_LABEL[c]}</option>)}
                        </select>
                        <select className="input input-sm" value={d.scopeKind} onChange={e => setDraft(t.id, { scopeKind: e.target.value })}>
                          {Object.entries(SCOPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                        {d.scopeKind === 'unit' ? (
                          <>
                            <select className="input input-sm" value={d.propertyId} onChange={e => setDraft(t.id, { propertyId: e.target.value, unitId: '' })}>
                              <option value="">Property…</option>
                              {properties.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                            </select>
                            <select className="input input-sm" value={d.unitId} onChange={e => setDraft(t.id, { unitId: e.target.value })} disabled={!d.propertyId}>
                              <option value="">Unit…</option>
                              {unitsForProp(d.propertyId).map((u: any) => <option key={u.id} value={u.id}>{u.unitNumber || u.name || u.label}</option>)}
                            </select>
                          </>
                        ) : (
                          <select className="input input-sm" value={d.propertyId} onChange={e => setDraft(t.id, { propertyId: e.target.value })}>
                            <option value="">Property…</option>
                            {properties.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        )}
                        {t.suggestedCategory && <span style={{ fontSize: '.68rem', color: 'var(--gold)' }}>suggested</span>}
                        <button className="btn btn-primary btn-sm" onClick={() => submit(t)} disabled={categorize.isLoading}>
                          <Check size={14} /> Confirm
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => ignore.mutate(t.id)}><X size={14} /> Ignore</button>
                      </div>
                    )}

                    {view === 'needs_review' && !isExpense && (
                      <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
                        <span style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
                          Money in — not a GAM payout we recognized. Only expenses (money out) are categorized here.
                        </span>
                        <button className="btn btn-ghost btn-sm" onClick={() => ignore.mutate(t.id)}><X size={14} /> Ignore</button>
                      </div>
                    )}

                    {view === 'categorized' && (
                      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 4 }}>Added to your expenses.</div>
                    )}
                  </div>
                )
              })}
            </div>}
      </div>
    </div>
  )
}
