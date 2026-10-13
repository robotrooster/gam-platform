/**
 * 10/12 (Nic, L5): Categories — the company's own labels for money out and
 * money in.
 *
 *   "those all sound like real expenses. just let bookkeeper/landlord create
 *    custom labels or categories to charge things off to."
 *
 * GAM starts every company with sensible categories (the old fixed lists) and
 * the owner or bookkeeper adds, renames and archives their own. Each category
 * charges to an account of the company's chart: until it is pointed somewhere,
 * the account GAM gave it. Pointed at an expense account (money out) or an
 * income account (money in), its money is on the Profit & Loss; pointed
 * anywhere else — an owner draw on equity, a purchase on an asset — it is
 * real money out or in, but not a cost or earnings of the business, and stays
 * off the P&L by itself. Pointing it again moves postings from today on;
 * earlier ones stay where they were. Nothing is ever removed: an archived
 * category leaves the pickers, and what was filed under it stays there.
 *
 * GAM Books' own page, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts). The server decides who may do what
 * (routes/expenses.ts): pointing at an account needs the company's ledger.
 */
import { useState } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import {
  BOOKS_CATEGORY_DIRECTIONS, BOOKS_CATEGORY_DIRECTION_LABEL, BOOKS_CATEGORY_NAME_MAX, BOOKS_CATEGORY_SYSTEM_USE_LABEL,
  BOOKS_ACCOUNT_TYPE_LABEL, type BooksCategoryDirection, type BooksAccountType, type BooksCategorySystemUse,
} from '@gam/shared'
import { booksGet as get, booksPost as post, booksPatch as patch, booksPath, toast } from './adapter'
import { Link } from 'react-router-dom'
import { loadErrorText } from './booksMoney'

interface Category {
  id: string; direction: BooksCategoryDirection; name: string; systemKey: string | null
  systemUse: BooksCategorySystemUse | null; archived: boolean
  accountId: string | null; accountCode: string | null; accountName: string | null; accountType: string | null
  pointed: boolean; onProfitAndLoss: boolean; used: number
}
interface Account { id: string; code: string; name: string; type: BooksAccountType }
// 10/12 (Nic, ledger decision 2): one level — every bookkeeper keeps the
// categories; there is no read-only bookkeeper (the API's canWrite is always
// true for anyone shown this page, so the page no longer reads it).
interface CategoriesData { categories: Category[]; accounts: Account[]; canPointAccounts: boolean }

const DIRECTION_HELP: Record<BooksCategoryDirection, string> = {
  expense: 'What you file money going out under — on the Expenses page and when you file a bank line.',
  income: 'What you file money coming in under that is not a tenant\'s payment — laundry, vending, an insurance check.',
}

export function CategoriesPage() {
  const qc = useQueryClient()
  const [showArchived, setShowArchived] = useState(false)
  const { data, isLoading, error, refetch, isFetching } = useQuery<CategoriesData>(['books-categories', showArchived],
    () => get<CategoriesData>(`/expenses/categories${showArchived ? '?archived=true' : ''}`))
  const [adding, setAdding] = useState<{ direction: BooksCategoryDirection; name: string; accountId: string } | null>(null)
  const [editing, setEditing] = useState<{ id: string; name: string; accountId: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const reload = () => { qc.invalidateQueries('books-categories'); qc.invalidateQueries('expense-options') }
  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true); setErr('')
    try {
      await work()
      toast(done)
      reload()
      return true
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Could not save that.')
      return false
    } finally { setBusy(false) }
  }

  if (isLoading) return <div className="bk-loading" style={{ padding: 32, textAlign: 'center' }}><span className="spinner" style={{ display: 'inline-block' }} /></div>
  if (error || !data) {
    return (
      <div className="alert ae" style={{ alignItems: 'center' }}>
        <span style={{ flex: 1 }}>{loadErrorText(error, 'Could not load your categories.')}</span>
        <button className="btn bp bsm" disabled={isFetching} onClick={() => refetch()}>{isFetching ? 'Loading…' : 'Load again'}</button>
      </div>
    )
  }

  const accountLabel = (c: Category) => c.accountName ? `${c.accountCode ? c.accountCode + ' · ' : ''}${c.accountName}` : 'Set up when your books first post'
  const accountsFor = (direction: BooksCategoryDirection) => [...data.accounts].sort((a, b) => {
    const want = direction === 'expense' ? 'expense' : 'income'
    return (a.type === want ? 0 : 1) - (b.type === want ? 0 : 1) || a.code.localeCompare(b.code)
  })

  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">🏷 Categories</h1>
          <p className="ps">Your own labels for money going out and coming in, and the account each one charges to.</p>
        </div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', textTransform: 'none', letterSpacing: 0, fontSize: '.8rem' }}>
          <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} style={{ width: 'auto' }} />
          Show archived
        </label>
      </div>

      {!data.canPointAccounts && (
        <div className="alert agold">You can add and rename categories. Pointing one at an account of the chart is for someone with the company&apos;s ledger.</div>
      )}
      {err && <div className="alert ae">{err}</div>}

      {BOOKS_CATEGORY_DIRECTIONS.map(direction => {
        const rows = data.categories.filter(c => c.direction === direction)
        return (
          <div key={direction} className="card" style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
              <div className="ct" style={{ flex: 1 }}>{BOOKS_CATEGORY_DIRECTION_LABEL[direction]}</div>
              {adding?.direction !== direction && (
                <button className="btn bp bsm" onClick={() => { setErr(''); setAdding({ direction, name: '', accountId: '' }) }}>+ Add category</button>
              )}
            </div>
            <p style={{ fontSize: '.78rem', color: 'var(--t2)', lineHeight: 1.5, margin: '0 0 12px' }}>{DIRECTION_HELP[direction]}</p>

            {adding?.direction === direction && (
              <div className="frow2" style={{ marginBottom: 12, alignItems: 'end' }}>
                <div>
                  <label htmlFor={`cat-new-${direction}`}>Name</label>
                  <input id={`cat-new-${direction}`} value={adding.name} maxLength={BOOKS_CATEGORY_NAME_MAX}
                    onChange={e => setAdding({ ...adding, name: e.target.value })} placeholder="For example, Septic pumping" />
                </div>
                {data.canPointAccounts && (
                  <div>
                    <label htmlFor={`cat-new-acct-${direction}`}>Charges to (optional)</label>
                    <select id={`cat-new-acct-${direction}`} value={adding.accountId} onChange={e => setAdding({ ...adding, accountId: e.target.value })}>
                      <option value="">{direction === 'expense' ? 'Other expenses (for now)' : 'Other income (for now)'}</option>
                      {accountsFor(direction).map(a => <option key={a.id} value={a.id}>{a.code} · {a.name} ({BOOKS_ACCOUNT_TYPE_LABEL[a.type] ?? a.type})</option>)}
                    </select>
                  </div>
                )}
                <div className="factions" style={{ marginTop: 0 }}>
                  <button className="btn bg-btn bsm" disabled={busy} onClick={() => setAdding(null)}>Cancel</button>
                  <button className="btn bp bsm" disabled={busy || !adding.name.trim()} onClick={async () => {
                    if (await run(() => post('/expenses/categories', { direction, name: adding.name, accountId: adding.accountId || null }), 'Category added.')) setAdding(null)
                  }}>Add</button>
                </div>
              </div>
            )}

            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead><tr><th>Category</th><th>Charges to</th><th>On the P&amp;L</th><th style={{ textAlign: 'right' }}>Filed</th><th></th></tr></thead>
                <tbody>
                  {rows.map(c => editing?.id === c.id ? (
                    <tr key={c.id}>
                      <td><input aria-label="Name" value={editing.name} maxLength={BOOKS_CATEGORY_NAME_MAX}
                        onChange={e => setEditing({ ...editing, name: e.target.value })} /></td>
                      <td colSpan={3}>
                        {data.canPointAccounts ? (
                          <select aria-label="Charges to" value={editing.accountId} onChange={e => setEditing({ ...editing, accountId: e.target.value })}>
                            <option value="">{accountLabel(c)} (as now)</option>
                            {accountsFor(direction).filter(a => a.id !== c.accountId).map(a => (
                              <option key={a.id} value={a.id}>{a.code} · {a.name} ({BOOKS_ACCOUNT_TYPE_LABEL[a.type] ?? a.type})</option>
                            ))}
                          </select>
                        ) : <span className="bnote">{accountLabel(c)}</span>}
                        {editing.accountId && <div className="bnote">From today on. What was filed before today stays on {c.accountName ?? 'its account'}.</div>}
                      </td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn bg-btn bsm" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>{' '}
                        <button className="btn bp bsm" disabled={busy || !editing.name.trim()} onClick={async () => {
                          if (await run(() => patch(`/expenses/categories/${c.id}`, {
                            name: editing.name, ...(editing.accountId ? { accountId: editing.accountId } : {}),
                          }), 'Category saved.')) setEditing(null)
                        }}>Save</button>
                      </td>
                    </tr>
                  ) : (
                    <tr key={c.id} style={c.archived ? { opacity: 0.6 } : undefined}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{c.name}</div>
                        {c.systemUse && <div className="bnote" style={{ margin: 0 }}>{BOOKS_CATEGORY_SYSTEM_USE_LABEL[c.systemUse]}</div>}
                        {c.archived && <div className="bnote" style={{ margin: 0 }}>Archived</div>}
                      </td>
                      <td>{accountLabel(c)}{!c.pointed && c.accountName && <div className="bnote" style={{ margin: 0 }}>GAM&apos;s starting account</div>}</td>
                      <td>{c.onProfitAndLoss ? 'Yes' : `No — ${c.accountType ? (BOOKS_ACCOUNT_TYPE_LABEL[c.accountType as BooksAccountType] ?? c.accountType).toLowerCase() : 'not'} money`}</td>
                      <td style={{ textAlign: 'right' }}>{c.used}</td>
                      <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                        {!c.archived && <button className="btn bg-btn bsm" disabled={busy}
                          onClick={() => { setErr(''); setEditing({ id: c.id, name: c.name, accountId: '' }) }}>Edit</button>}{' '}
                        {c.systemUse !== 'payroll' && (
                          <button className="btn bg-btn bsm" disabled={busy}
                            onClick={() => run(() => patch(`/expenses/categories/${c.id}`, { archived: !c.archived }), c.archived ? 'Category brought back.' : 'Category archived.')}>
                            {c.archived ? 'Bring back' : 'Archive'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={5} className="bnote">No categories here yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}

      <p className="bnote">
        The accounts are on the <Link to={booksPath('accounts')} style={{ color: 'var(--gold)' }}>Chart of Accounts</Link>. A category
        pointed at an account GAM keeps from the money records (rent owed, deposits, money GAM holds) is refused.
      </p>
    </div>
  )
}
