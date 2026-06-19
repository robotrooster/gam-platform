import { useEffect, useState } from 'react'
import { apiGet, apiPost, apiPatch, apiDelete } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { BookOpen, Plus, Receipt, TrendingUp, Pencil, Trash2 } from 'lucide-react'

// S459 — business bookkeeping, built on the reused GAM Books engine
// (books tables scoped by business_id). Three tabs: P&L report, expense /
// income transactions, and the chart of accounts. Payroll / 1099 / bills
// exist in the engine but are a later increment for businesses.

interface Account {
  id: string; code: string; name: string
  type: 'asset' | 'liability' | 'equity' | 'income' | 'expense'
  balance: string
}
interface Txn {
  id: string; date: string; description: string
  amount: string; type: string; category: string | null
  accountId: string | null; accountName: string | null
}
interface PLAccount { code: string; name: string; periodAmount: string }
interface PLReport {
  period: { start: string; end: string }
  income: PLAccount[]; expenses: PLAccount[]
  totalIncome: number; totalExpenses: number; netIncome: number
  // Auto-pulled real sales: completed POS + collected invoices.
  gamBusinessRevenue: number
}

const fmtMoney = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

const todayISO = () => new Date().toISOString().slice(0, 10)
const yearStartISO = () => `${new Date().getFullYear()}-01-01`

type Tab = 'pl' | 'expenses' | 'accounts'

export function BookkeepingPage() {
  const { business } = useAuth()
  const enabled = (business?.enabledFeatures ?? []).includes('bookkeeping')
  const [tab, setTab] = useState<Tab>('pl')

  if (!enabled) {
    return (
      <div>
        <h1 style={h1Style}>Bookkeeping</h1>
        <div style={cardStyle}>
          Bookkeeping isn't enabled for this business. Turn it on in
          Settings → Features to track expenses and run a profit &amp; loss report.
        </div>
      </div>
    )
  }

  return (
    <div>
      <h1 style={h1Style}><BookOpen size={22} style={{ marginRight: 8, verticalAlign: -3 }} />Bookkeeping</h1>
      <div style={{ display: 'flex', gap: 4, padding: 4, background: 'var(--bg-2)', borderRadius: 10, marginBottom: 20, maxWidth: 420 }}>
        {([['pl', 'Profit & Loss', TrendingUp], ['expenses', 'Expenses', Receipt], ['accounts', 'Accounts', BookOpen]] as const).map(([k, label, Icon]) => (
          <button key={k} onClick={() => setTab(k)}
            style={{
              flex: 1, padding: '8px 12px', borderRadius: 6, border: 'none', cursor: 'pointer',
              fontSize: 13, fontWeight: 600,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              background: tab === k ? 'var(--bg-1)' : 'transparent',
              color: tab === k ? 'var(--gold)' : 'var(--text-2)',
            }}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {tab === 'pl' && <ProfitLossTab />}
      {tab === 'expenses' && <ExpensesTab />}
      {tab === 'accounts' && <AccountsTab />}
    </div>
  )
}

// ── Profit & Loss ──────────────────────────────────────────────────
function ProfitLossTab() {
  const [start, setStart] = useState(yearStartISO())
  const [end, setEnd] = useState(todayISO())
  const [report, setReport] = useState<PLReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = async () => {
    setLoading(true); setErr(null)
    try {
      const r = await apiGet<PLReport>(`/books/reports/pl?startDate=${start}&endDate=${end}`)
      setReport(r)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load report')
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap' }}>
        <div>
          <label style={labelStyle}>From</label>
          <input type="date" value={start} onChange={e => setStart(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={labelStyle}>To</label>
          <input type="date" value={end} onChange={e => setEnd(e.target.value)} style={inputStyle} />
        </div>
        <button onClick={load} style={primaryBtn}>Run report</button>
      </div>

      {err && <div style={errStyle}>{err}</div>}
      {loading ? <div style={{ color: 'var(--text-2)' }}>Loading…</div> : report && (() => {
        const autoRev = report.gamBusinessRevenue || 0
        const incomeTotal = report.totalIncome + autoRev
        const net = incomeTotal - report.totalExpenses
        return (
        <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
          <PLSection title="Income" rows={report.income} total={incomeTotal} positive
            extra={autoRev !== 0 ? { label: 'Invoices & POS (collected)', amount: autoRev } : undefined} />
          <PLSection title="Expenses" rows={report.expenses} total={report.totalExpenses} />
          <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <div style={{ color: 'var(--text-2)', fontSize: 13 }}>Net profit</div>
            <div style={{
              fontSize: 30, fontWeight: 700, marginTop: 6,
              color: net >= 0 ? 'var(--green, #22c55e)' : 'var(--red, #ef4444)',
            }}>{fmtMoney(net)}</div>
            <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 8 }}>
              {report.period.start} → {report.period.end}
            </div>
          </div>
        </div>
        )
      })()}
    </div>
  )
}

function PLSection({ title, rows, total, positive, extra }: {
  title: string; rows: PLAccount[]; total: number; positive?: boolean
  extra?: { label: string; amount: number }
}) {
  const active = rows.filter(r => +r.periodAmount !== 0)
  return (
    <div style={cardStyle}>
      <div style={{ fontWeight: 600, marginBottom: 10 }}>{title}</div>
      {extra && (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
          <span style={{ color: 'var(--text-1)' }}>{extra.label}</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtMoney(extra.amount)}</span>
        </div>
      )}
      {active.length === 0 && !extra ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>No activity in this period.</div>
      ) : active.map(r => (
        <div key={r.code} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '4px 0' }}>
          <span style={{ color: 'var(--text-1)' }}>{r.name}</span>
          <span style={{ fontFamily: 'var(--font-mono)' }}>{fmtMoney(+r.periodAmount)}</span>
        </div>
      ))}
      <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--border-1)', marginTop: 8, paddingTop: 8, fontWeight: 600 }}>
        <span>Total {title.toLowerCase()}</span>
        <span style={{ fontFamily: 'var(--font-mono)', color: positive ? 'var(--green, #22c55e)' : 'var(--text-0)' }}>{fmtMoney(total)}</span>
      </div>
    </div>
  )
}

// ── Expenses / income transactions ─────────────────────────────────
function ExpensesTab() {
  const [rows, setRows] = useState<Txn[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const blank = { date: todayISO(), description: '', amount: '', type: 'expense', accountId: '', category: '' }
  const [form, setForm] = useState(blank)

  const load = async () => {
    setLoading(true)
    try {
      const [txns, accts] = await Promise.all([
        apiGet<Txn[]>('/books/transactions'),
        apiGet<Account[]>('/books/accounts'),
      ])
      setRows(txns); setAccounts(accts)
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Failed to load')
    } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const startEdit = (r: Txn) => {
    setEditingId(r.id)
    setForm({
      date: r.date?.slice(0, 10) || todayISO(),
      description: r.description,
      amount: String(r.amount),
      type: r.type,
      accountId: r.accountId || '',
      category: r.category || '',
    })
  }
  const cancelEdit = () => { setEditingId(null); setForm(blank) }

  const remove = async (r: Txn) => {
    if (!window.confirm(`Delete "${r.description}"? This can't be undone.`)) return
    setErr(null)
    try { await apiDelete(`/books/transactions/${r.id}`); if (editingId === r.id) cancelEdit(); await load() }
    catch (e: any) { setErr(e?.response?.data?.error || 'Delete failed') }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null)
    if (!form.description.trim() || !form.amount) { setErr('Description and amount required'); return }
    setSaving(true)
    const payload = {
      date: form.date,
      description: form.description.trim(),
      amount: Number(form.amount),
      type: form.type,
      category: form.category.trim() || null,
      accountId: form.accountId || null,
    }
    try {
      if (editingId) await apiPatch(`/books/transactions/${editingId}`, payload)
      else await apiPost('/books/transactions', payload)
      cancelEdit()
      await load()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Save failed')
    } finally { setSaving(false) }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24 }}>
      <div>
        {err && <div style={errStyle}>{err}</div>}
        {loading ? <div style={{ color: 'var(--text-2)' }}>Loading…</div> : rows.length === 0 ? (
          <div style={cardStyle}>No transactions yet. Record your first expense on the right.</div>
        ) : (
          <table style={tableStyle}>
            <thead><tr style={{ borderBottom: '1px solid var(--border-1)' }}>
              <th style={thStyle}>Date</th><th style={thStyle}>Description</th>
              <th style={thStyle}>Account</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Amount</th>
              <th style={thStyle}></th>
            </tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--border-0)',
                  background: editingId === r.id ? 'rgba(212,175,55,.08)' : undefined }}>
                  <td style={tdStyle}>{r.date?.slice(0, 10)}</td>
                  <td style={tdStyle}>{r.description}
                    {r.category && <span style={{ color: 'var(--text-3)', fontSize: 11, marginLeft: 6 }}>{r.category}</span>}
                  </td>
                  <td style={{ ...tdStyle, color: 'var(--text-2)' }}>{r.accountName || '—'}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--font-mono)',
                    color: r.type === 'income' ? 'var(--green, #22c55e)' : 'var(--text-0)' }}>
                    {r.type === 'income' ? '+' : '−'}{fmtMoney(+r.amount)}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button onClick={() => startEdit(r)} title="Edit" style={iconBtn}><Pencil size={13} /></button>
                    <button onClick={() => remove(r)} title="Delete" style={{ ...iconBtn, color: '#f87171' }}><Trash2 size={13} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <h2 style={h2Style}>{editingId ? 'Edit transaction' : 'Record transaction'}</h2>
        <form onSubmit={submit} style={cardStyle}>
          <label style={labelStyle}>Type</label>
          <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} style={inputStyle}>
            <option value="expense">Expense</option>
            <option value="income">Income</option>
          </select>
          <label style={labelStyle}>Date</label>
          <input type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} style={inputStyle} />
          <label style={labelStyle}>Description</label>
          <input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} style={inputStyle} />
          <label style={labelStyle}>Amount</label>
          <input type="number" step="0.01" min="0" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} style={inputStyle} />
          <label style={labelStyle}>Account (optional)</label>
          <select value={form.accountId} onChange={e => setForm({ ...form, accountId: e.target.value })} style={inputStyle}>
            <option value="">— none —</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </select>
          <label style={labelStyle}>Category (optional)</label>
          <input value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} style={inputStyle} />
          <button type="submit" disabled={saving} style={{ ...primaryBtn, marginTop: 12, width: '100%' }}>
            {saving ? 'Saving…' : editingId ? 'Update transaction' : 'Add transaction'}
          </button>
          {editingId && (
            <button type="button" onClick={cancelEdit}
              style={{ ...primaryBtn, background: 'transparent', color: 'var(--text-2)',
                border: '1px solid var(--border-1)', marginTop: 8, width: '100%' }}>
              Cancel edit
            </button>
          )}
        </form>
      </div>
    </div>
  )
}

// ── Chart of accounts ──────────────────────────────────────────────
function AccountsTab() {
  const [rows, setRows] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ code: '', name: '', type: 'expense' })

  const load = async () => {
    setLoading(true)
    try { setRows(await apiGet<Account[]>('/books/accounts')) }
    catch (e: any) { setErr(e?.response?.data?.error || 'Failed to load') }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const seed = async () => {
    setBusy(true); setErr(null)
    try { await apiPost('/books/accounts/seed'); await load() }
    catch (e: any) { setErr(e?.response?.data?.error || 'Seed failed') }
    finally { setBusy(false) }
  }
  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null)
    if (!form.code.trim() || !form.name.trim()) { setErr('Code and name required'); return }
    setBusy(true)
    try {
      await apiPost('/books/accounts', { code: form.code.trim(), name: form.name.trim(), type: form.type })
      setForm({ code: '', name: '', type: 'expense' })
      await load()
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Add failed')
    } finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24 }}>
      <div>
        {err && <div style={errStyle}>{err}</div>}
        {loading ? <div style={{ color: 'var(--text-2)' }}>Loading…</div> : rows.length === 0 ? (
          <div style={cardStyle}>
            <div style={{ marginBottom: 12 }}>No accounts yet. Start with a standard chart of accounts for your business.</div>
            <button onClick={seed} disabled={busy} style={primaryBtn}>
              <Plus size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
              {busy ? 'Seeding…' : 'Seed standard accounts'}
            </button>
          </div>
        ) : (
          <table style={tableStyle}>
            <thead><tr style={{ borderBottom: '1px solid var(--border-1)' }}>
              <th style={thStyle}>Code</th><th style={thStyle}>Name</th>
              <th style={thStyle}>Type</th>
              <th style={{ ...thStyle, textAlign: 'right' }}>Balance</th>
            </tr></thead>
            <tbody>
              {rows.map(a => (
                <tr key={a.id} style={{ borderBottom: '1px solid var(--border-0)' }}>
                  <td style={{ ...tdStyle, fontFamily: 'var(--font-mono)' }}>{a.code}</td>
                  <td style={tdStyle}>{a.name}</td>
                  <td style={{ ...tdStyle, color: 'var(--text-2)', textTransform: 'capitalize' }}>{a.type}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{fmtMoney(+a.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div>
        <h2 style={h2Style}>Add account</h2>
        <form onSubmit={add} style={cardStyle}>
          <label style={labelStyle}>Code</label>
          <input value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} placeholder="6010" style={inputStyle} />
          <label style={labelStyle}>Name</label>
          <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Tools & Supplies" style={inputStyle} />
          <label style={labelStyle}>Type</label>
          <select value={form.type} onChange={e => setForm({ ...form, type: e.target.value })} style={inputStyle}>
            <option value="asset">Asset</option>
            <option value="liability">Liability</option>
            <option value="equity">Equity</option>
            <option value="income">Income</option>
            <option value="expense">Expense</option>
          </select>
          <button type="submit" disabled={busy} style={{ ...primaryBtn, marginTop: 12, width: '100%' }}>Add account</button>
        </form>
      </div>
    </div>
  )
}

// ── styles ─────────────────────────────────────────────────────────
const h1Style: React.CSSProperties = { fontFamily: 'var(--font-display)', fontSize: 28, marginTop: 0 }
const h2Style: React.CSSProperties = { fontSize: 15, marginTop: 0, marginBottom: 10 }
const cardStyle: React.CSSProperties = {
  background: 'var(--bg-1)', border: '1px solid var(--border-1)', borderRadius: 12,
  padding: 16, color: 'var(--text-1)', fontSize: 14,
}
const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 12, color: 'var(--text-2)', marginTop: 10, marginBottom: 4,
}
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '9px 11px', background: 'var(--bg-2)', color: 'var(--text-0)',
  border: '1px solid var(--border-1)', borderRadius: 8, fontSize: 13, boxSizing: 'border-box',
}
const primaryBtn: React.CSSProperties = {
  padding: '9px 16px', background: 'var(--gold)', color: 'var(--bg-0)', border: 'none',
  borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
}
const errStyle: React.CSSProperties = {
  background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.3)', color: '#f87171',
  padding: '10px 12px', borderRadius: 8, fontSize: 13, marginBottom: 12,
}
const tableStyle: React.CSSProperties = { width: '100%', borderCollapse: 'collapse' }
const thStyle: React.CSSProperties = {
  textAlign: 'left', fontSize: 11, color: 'var(--text-3)', fontWeight: 600,
  padding: '8px 10px', textTransform: 'uppercase', letterSpacing: '.04em',
}
const tdStyle: React.CSSProperties = { padding: '10px', fontSize: 13, color: 'var(--text-0)' }
const iconBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-2)',
  padding: 4, marginLeft: 4, verticalAlign: 'middle',
}
