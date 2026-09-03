// S570 (Nic): bank feed. Link an operating bank read-only via Stripe Financial
// Connections; GAM auto-matches the money it already knows (rent payouts) and
// surfaces the rest — a $1k Home Depot charge from the landlord's own bank — for
// a 2-click categorize into the P&L. The landlord ALWAYS confirms and ALWAYS
// picks scope (a unit, or the property split/common across units); auto-suggest
// only pre-fills from what this landlord chose for the same merchant before.
import { useMemo, useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { loadStripe } from '@stripe/stripe-js'
import { EntityPicker } from '../components/EntityPicker'
import { apiGet, apiPost , apiPut } from '../lib/api'
import { DepositMatchPanel, CashPositionPanel } from './DepositMatchPanel'
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABEL, OTHER_INCOME_CATEGORIES, OTHER_INCOME_CATEGORY_LABEL } from '@gam/shared'
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

// S603 (Nic): property_common and property_allocate now do the SAME thing —
// every cost not tied to one unit is split across that property's units. Both
// labels say so, so the list can't imply a difference that no longer exists.
// (The duplicate enum value itself needs a migration to retire.)
const SCOPE_LABEL: Record<string, string> = {
  unit: 'One unit',
  property_common: 'Whole property, split per unit',
  property_allocate: 'Whole property, split per unit',
}

// What the PICKER offers. SCOPE_LABEL above still maps both property values so
// an existing rule saved as property_allocate still displays correctly, but the
// dropdown must not show the same choice twice.
const SCOPE_CHOICES: [string, string][] = [
  ['unit', SCOPE_LABEL.unit],
  ['property_common', SCOPE_LABEL.property_common], // wire-ok: local constant map, not an API response
]

type Draft = { category: string; scopeKind: string; propertyId: string; unitId: string }

// S605 (Nic): merged into a single "Bank" tab alongside reconciliation.
// `embedded` renders this as a section of BankPage rather than its own screen.
export function BankFeedPage({ embedded = false }: { embedded?: boolean } = {}) {
  const qc = useQueryClient()
  const [linking, setLinking] = useState(false)
  const [linkErr, setLinkErr] = useState<string | null>(null)
  const [view, setView] = useState<'needs_review' | 'categorized' | 'ignored'>('needs_review')

  // S629 (Nic): "a property selector or entity selector, to view the
  // transaction logs and stuff specific to that entity." The feed was pinned
  // to the primary entity server-side, so a second LLC's transactions were
  // unreachable — not empty, unreachable.
  const [entityId, setEntityId] = useState<string>('')
  const entityQS = entityId ? `entityId=${encodeURIComponent(entityId)}` : ''
  const { data: connections = [] } = useQuery<any[]>(
    ['bank-connections', entityId],
    () => apiGet(`/bank-feed/connections${entityQS ? `?${entityQS}` : ''}`))
  const { data: properties = [] } = useQuery<any[]>('properties', () => apiGet('/properties'))
  const { data: units = [] } = useQuery<any[]>('units', () => apiGet('/units'))
  const { data: txns = [], isLoading } = useQuery<any[]>(
    ['bank-txns', view, entityId],
    () => apiGet(`/bank-feed/transactions?status=${view}${entityQS ? `&${entityQS}` : ''}`))

  const propOf = (u: any) => u.propertyId
  const unitsForProp = (pid: string) => (units as any[]).filter(u => propOf(u) === pid)

  // Per-row categorize draft, pre-seeded from the merchant suggestion.
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const draftFor = (t: any): Draft => drafts[t.id] || {
    // Income rows must not default to an expense category — confirming without
    // touching the dropdown would file a deposit as 'repairs'.
    category: t.suggestedCategory || (Number(t.amount) > 0 ? 'other' : 'repairs'),
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
      // S637: send the company the picker is on. Without it the endpoint fell
      // back to "which of your companies?" and refused, after the landlord had
      // already answered that question on screen.
      const { data: session } = await apiPost('/bank-feed/link-session', { entityId })
      const { clientSecret, sessionId } = session
      const result = await (stripe as any).collectFinancialConnectionsAccounts({ clientSecret })
      if (result.error) throw new Error(result.error.message)
      const accounts = result.financialConnectionsSession?.accounts ?? []
      if (!accounts.length) { setLinking(false); return } // user closed the modal
      await apiPost('/bank-feed/finalize', { sessionId, entityId })
      qc.invalidateQueries('bank-connections')
      qc.invalidateQueries(['bank-txns'])
      toast('Bank linked. Syncing transactions…')
    } catch (e: any) {
      // S605: this read data.message, but the API's error shape is
      // { success:false, error } — so it was ALWAYS undefined and every
      // failure here degraded to axios's raw "Request failed with status
      // code 400", hiding what Stripe actually said.
      setLinkErr(e?.response?.data?.error || e?.response?.data?.message || e?.message || 'Could not link the bank.')
    } finally {
      setLinking(false)
    }
  }

  // S605 (Nic): "when a landlord wants to onboard, say, October first, do we
  // wanna offer the option to not count previous transactions?" Linking pulls
  // the bank's whole history — Oak Park imported 112 rows back to February.
  // Anything before this date is kept but auto-ignored, so the review queue is
  // only the GAM era. Retroactive and reversible; categorized rows are never
  // touched.
  // S633: books-start-date is a COMPANY's setting, and this page already knows
  // which company the user is looking at. Without the id, /landlords/me now asks
  // an account that owns several which one it means — so pass the one already
  // selected above rather than making them answer twice.
  const { data: me } = useQuery<any>(
    ['landlord-books-start', entityId],
    () => apiGet(`/landlords/me?landlordId=${entityId}`),
    { enabled: !!entityId })
  const [booksStart, setBooksStart] = useState<string>('')
  useEffect(() => {
    if (me?.booksStartDate) setBooksStart(String(me.booksStartDate).slice(0, 10))
  }, [me?.booksStartDate])

  const saveBooksStart = useMutation(
    (date: string | null) => apiPut('/bank-feed/books-start-date', { date }),
    { onSuccess: (r: any) => {
        qc.invalidateQueries(['bank-txns']); qc.invalidateQueries('landlord-books-start')
        const ig = r?.data?.ignored ?? 0, re = r?.data?.restored ?? 0
        toast(ig || re
          ? `Updated — ${ig} hidden, ${re} brought back for review.`
          : 'Start date saved.')
      },
      onError: (e: any) => toast(e?.response?.data?.error || 'Could not save the start date.') },
  )

  const sync = useMutation((id: string) => apiPost(`/bank-feed/connections/${id}/sync`, {}), {
    onSuccess: (d: any) => { qc.invalidateQueries(['bank-txns']); qc.invalidateQueries('bank-connections')
      const n = d?.data?.inserted; toast(n ? `${n} new transaction(s).` : 'Up to date.') },
    onError: (e: any) => toast(e?.response?.data?.error || e?.response?.data?.message || 'Sync failed.'),
  })

  const disconnect = useMutation((id: string) => apiPost(`/bank-feed/connections/${id}/disconnect`, {}), {
    onSuccess: () => { qc.invalidateQueries('bank-connections'); toast('Bank disconnected.') },
  })

  const categorize = useMutation(
    ({ id, body }: { id: string; body: any }) => apiPost(`/bank-feed/transactions/${id}/categorize`, body), {
    onSuccess: (r: any) => { qc.invalidateQueries(['bank-txns'])
      // The API returns incomeId for money in, expenseId for money out — say
      // which side it landed on rather than always claiming "expenses".
      toast(r?.data?.incomeId ? 'Categorized → added to your income.' : 'Categorized → added to your expenses.') },
    onError: (e: any) => toast(e?.response?.data?.error || e?.response?.data?.message || 'Could not categorize.'),
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
      {/* S629: the feed, the connections and every categorization below belong
          to the entity chosen here. Hidden for a one-entity portfolio. */}
      <EntityPicker value={entityId} onChange={setEntityId} label="Transactions for" />
      {embedded ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, margin: '26px 0 12px' }}>
          <div>
            <div style={{ fontWeight: 700, color: 'var(--text-0)' }}>Your spending</div>
            <div style={{ fontSize: '.78rem', color: 'var(--text-2)' }}>
              Link your bank read-only. Rent payouts GAM already knows about are hidden; the rest is
              yours to categorize into your P&L.
            </div>
          </div>
          <button className="btn btn-primary" onClick={link} disabled={linking}>
            <Plus size={16} /> {linking ? 'Linking…' : 'Connect feed'}
          </button>
        </div>
      ) : (
        <div className="page-header">
          <div>
            <h1 className="page-title">Bank Feed</h1>
            <p className="page-subtitle">
              Link your operating bank read-only. GAM hides the money it already tracks (rent payouts)
              and surfaces the rest — your own spending — to categorize into your P&L in two clicks.
            </p>
          </div>
          <button className="btn btn-primary" onClick={link} disabled={linking}>
            <Plus size={16} /> {linking ? 'Linking…' : 'Connect feed'}
          </button>
        </div>
      )}
      {linkErr && <div className="card" style={{ borderColor: 'var(--danger)', color: 'var(--danger)', marginBottom: 16 }}>{linkErr}</div>}

      {/* S576 (B-5): signpost the sibling workflow so the two "bank" tabs read as
          distinct jobs — this one CATEGORIZES spend; the other MATCHES a statement. */}
      {!embedded && (
        <div style={{ fontSize: '.76rem', color: 'var(--text-3)', marginBottom: 16, lineHeight: 1.5 }}>
          This is for <strong>categorizing spending</strong> from a linked bank into your P&L.
        </div>
      )}

      {/* S624 — DEPOSITS THAT PAID RENT, above the expense queue on purpose.
          A tenant's rent sitting unattributed is time-sensitive in a way a
          Home Depot receipt is not: late fees are accruing on it while it waits,
          and every day it sits is a day of fees that will have to be reversed. */}
      <div style={{ marginBottom: 20 }}>
        <div className="card-title" style={{ marginBottom: 8 }}>Deposits that may be rent</div>
        <div style={{ fontSize: '.76rem', color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.5 }}>
          Money paid in at a branch, matched to what each tenant owes. Recording it
          here dates the payment to when the deposit was actually made — so any late
          fee charged while it was in transit comes back off.
        </div>
        <DepositMatchPanel />
      </div>

      {/* The other side of the same question: cash marked collected in person
          that no deposit has accounted for. */}
      <div style={{ marginBottom: 20 }}>
        <CashPositionPanel />
      </div>

      {/* Linked banks */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-title" style={{ marginBottom: 12 }}>Linked banks</div>
        {connections.length === 0
          ? <div style={{ color: 'var(--text-3)', fontSize: '.85rem', lineHeight: 1.6 }}>
              No banks linked yet.
              {/* S605 (Nic): he finished Stripe payout setup and reasonably expected
                  this to fill in. It can't. Stripe Connect tells GAM WHERE TO SEND
                  money; this needs READ access to the bank's transaction history,
                  which is a different permission the bank itself must grant — even
                  for the same account. Say so here, because the Banking page had
                  exactly this confusion and it cost real time. */}
              <div style={{ marginTop: 8, color: 'var(--text-2)' }}>
                <strong style={{ color: 'var(--text-1)' }}>This is separate from your payout setup.</strong>{' '}
                Verifying with Stripe told GAM where to <em>send</em> your rent. This asks your bank for
                read-only permission to <em>see</em> what you spend, so it can land in your P&L —
                a different permission, so your bank has to approve it even if it's the same account.
              </div>
              <div style={{ marginTop: 8 }}>
                Hit <strong>Connect feed</strong> above and sign in to your bank. Read-only —
                nothing can move money from here.
              </div>
            </div>
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
                  {/* S605: the account balance, which is what a landlord looks
                      for first on a page about their bank. Absent for links made
                      before balances consent — those show a re-link prompt
                      instead of a blank, so the fix is discoverable. */}
                  <div style={{ textAlign: 'right', marginRight: 4 }}>
                    {c.currentBalance != null
                      ? <>
                          <div style={{ fontWeight: 700, fontSize: '.95rem' }}>{fmt(c.currentBalance)}</div>
                          <div style={{ fontSize: '.68rem', color: 'var(--text-3)' }}>
                            balance{c.balanceAsOf ? ` · ${fmtDate(c.balanceAsOf)}` : ''}
                          </div>
                        </>
                      : <div style={{ fontSize: '.68rem', color: 'var(--text-3)', maxWidth: 150 }}>
                          Balance needs a quick re-link
                        </div>}
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

      {/* S605: books start date */}
      {connections.length > 0 && (
        <div className="card" style={{ marginBottom: 12, padding: 12, display: 'flex',
          alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ fontWeight: 600, fontSize: '.82rem' }}>Start my books from</div>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2, lineHeight: 1.5 }}>
              Anything before this stays on file but is hidden from review — use it to skip spending
              from before you joined GAM. Already-categorized transactions are never changed.
            </div>
          </div>
          <input className="form-input" type="date" value={booksStart} style={{ width: 'auto' }}
            onChange={e => setBooksStart(e.target.value)} />
          <button className="btn btn-primary btn-sm" disabled={saveBooksStart.isLoading || !booksStart}
            onClick={() => saveBooksStart.mutate(booksStart)}>Apply</button>
          {me?.booksStartDate && (
            <button className="btn btn-ghost btn-sm" disabled={saveBooksStart.isLoading}
              onClick={() => { setBooksStart(''); saveBooksStart.mutate(null) }}>Clear</button>
          )}
        </div>
      )}

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
                      {/* S605 (Nic): colour alone didn't say which way the money
                          went — "green numbers and white numbers" was a guess.
                          Label it. These are single transaction amounts, not a
                          running balance. */}
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontWeight: 700, color: isExpense ? 'var(--text-0)' : 'var(--success, #3fb950)' }}>{fmt(t.amount)}</div>
                        <div style={{ fontSize: '.64rem', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                          {isExpense ? 'money out' : 'money in'}
                        </div>
                      </div>
                    </div>

                    {/* S605 (Nic): "if the only option is to ignore it, why are we even
                        showing it on this page?" — money in used to be a dead end here.
                        It now categorizes as income exactly like money out categorizes as
                        an expense; only the category list differs. */}
                    {view === 'needs_review' && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8, alignItems: 'center' }}>
                        <select className="input input-sm" value={d.category} onChange={e => setDraft(t.id, { category: e.target.value })}>
                          {isExpense
                            ? EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{EXPENSE_CATEGORY_LABEL[c]}</option>)
                            : OTHER_INCOME_CATEGORIES.map(c => <option key={c} value={c}>{OTHER_INCOME_CATEGORY_LABEL[c]}</option>)}
                        </select>
                        <select className="input input-sm" value={d.scopeKind} onChange={e => setDraft(t.id, { scopeKind: e.target.value })}>
                          {SCOPE_CHOICES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
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

                    {view === 'categorized' && (
                      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 4 }}>
                        Added to your {isExpense ? 'expenses' : 'income'}.
                      </div>
                    )}
                  </div>
                )
              })}
            </div>}
      </div>
    </div>
  )
}
