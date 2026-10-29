/**
 * 10/12 (Nic): Opening Balances — what this company's books start with on its
 * books start date. "History start = landlord's choice (since joining GAM, or a
 * start date + opening balances)"; pre-GAM deposits are the landlord's choice
 * to enter (L14).
 *
 *   - Bank accounts: each linked account's balance on the start date (GAM
 *     suggests one from the bank feed when it reaches back that far).
 *   - Other balances: cash on hand, an account GAM does not see, a loan,
 *     equipment — on an account from the company's chart.
 *   - Deposits held from before GAM: tenant, amount, the day it was paid.
 *   - Home sales still owed: worked out from the contracts, shown to check.
 * Nothing is ever deleted: an entry made by mistake is voided, saying why.
 * The owner enters; a bookkeeper with the ledger box reads (bank balances only
 * with the company-wide box) — the server decides (routes/booksSettings.ts).
 *
 * GAM Books' own page, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts). How it reaches the API, shows a toast and links
 * to another Books page is the app's own (./adapter).
 */
import React, { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from 'react-query'
import { formatCurrency, longCalendarDate, BOOKS_ACCOUNT_TYPE_LABEL } from '@gam/shared'
import { booksGet as get, booksPost as post, booksPath, toast } from './adapter'
import { Modal } from './common'
import { loadErrorText } from './booksMoney'

interface OpeningItem {
  id: string; kind: string; amount: string; asOf: string; paidOn: string | null; memo: string | null
  enteredAt: string; voidedAt: string | null; voidReason: string | null; stale: boolean
  bankConnectionId: string | null; bankName: string | null
  leaseId: string | null; tenantName: string | null; propertyName: string | null; unitLabel: string | null
  accountId: string | null; accountCode: string | null; accountName: string | null; accountType: string | null
}
interface BankAccount { id: string; name: string; status: string; suggested: string | null; balanceAsOf: string | null; feedFrom: string | null }
interface HomeSale {
  contractId: string; buyerName: string; propertyName: string | null; unitLabel: string | null; status: string
  financed: string; principalBeforeStart: string; stillOwed: string; billedUnpaid: string
}
interface LeaseOption { leaseId: string; tenantName: string | null; propertyName: string; unitLabel: string; startDate: string; endDate: string | null; gamDeposit: string | null }
interface AccountOption { id: string; code: string; name: string; type: string }
interface OpeningView {
  canEdit: boolean; seesBank: boolean; booksStartDate: string | null; closedThrough: string | null
  homeSaleMethod: string | null; chartReady: boolean
  items: OpeningItem[]; bankAccounts: BankAccount[] | null; homeSales: HomeSale[]
  leases: LeaseOption[]; accounts: AccountOption[]
}

const money = (v: string | number | null | undefined) => formatCurrency(Number(v) || 0)
const day = (d: string | null | undefined) => (d ? longCalendarDate(d) : '—')
const home = (unit: string | null, property: string | null) => [unit, property].filter(Boolean).join(' · ') || '—'
const accountTypeLabel = (t: string | null) => (t ? (BOOKS_ACCOUNT_TYPE_LABEL as Record<string, string>)[t] ?? '' : '')

function Section({ title, help, action, children }: { title: string; help?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <div className="ct" style={{ marginBottom: 0 }}>{title}</div>
        {action}
      </div>
      {help && <p style={{ fontSize: '.78rem', color: 'var(--t2)', lineHeight: 1.5, margin: '0 0 12px' }}>{help}</p>}
      {children}
    </div>
  )
}
/** A table that scrolls inside its card on a phone, never the page. */
function Scroll({ children }: { children: ReactNode }) {
  return <div style={{ overflowX: 'auto' }}>{children}</div>
}
function Stale() {
  return <span className="badge ba" style={{ marginLeft: 6 }}>Check it</span>
}

type Dialog =
  | { kind: 'bank'; account: BankAccount; current: OpeningItem | null }
  | { kind: 'other' }
  | { kind: 'deposit' }
  | { kind: 'void'; item: OpeningItem }
  | null

export function OpeningBalancesPage() {
  const qc = useQueryClient()
  const { data, isLoading, error, refetch, isFetching } = useQuery<OpeningView>('books-opening', () => get<OpeningView>('/books/setup/opening-balances'))
  const [dialog, setDialog] = useState<Dialog>(null)
  const [showVoided, setShowVoided] = useState(false)
  const [settingUp, setSettingUp] = useState(false)

  if (isLoading) return <div style={{ padding: 32, textAlign: 'center' }}><span className="spinner" style={{ display: 'inline-block' }} /></div>
  if (error || !data) {
    return (
      <div className="alert ae" style={{ alignItems: 'center' }}>
        <span style={{ flex: 1 }}>{loadErrorText(error, 'Could not load the opening balances.')}</span>
        <button className="btn bp bsm" disabled={isFetching} onClick={() => refetch()}>{isFetching ? 'Loading…' : 'Load again'}</button>
      </div>
    )
  }

  const settingsLink = <Link to={booksPath('booksSettings')} style={{ color: 'var(--gold)' }}>Books Settings</Link>
  if (!data.booksStartDate) {
    return (
      <div>
        <div className="ph"><div><h1 className="pt">🧮 Opening Balances</h1><p className="ps">What your books start with.</p></div></div>
        <div className="card" style={{ textAlign: 'center', padding: '36px 20px' }}>
          <p style={{ color: 'var(--t1)', fontSize: '.88rem', margin: 0 }}>Your books do not have a start date yet.</p>
          <p style={{ color: 'var(--t3)', fontSize: '.8rem', marginTop: 6 }}>
            {data.canEdit ? <>Choose when they start on {settingsLink}; then enter what they start with here.</> : 'The owner chooses when they start.'}
          </p>
        </div>
      </div>
    )
  }

  const start = data.booksStartDate
  const live = data.items.filter(i => !i.voidedAt)
  const voided = data.items.filter(i => i.voidedAt)
  const liveBank = (connectionId: string) => live.find(i => i.kind === 'bank' && i.bankConnectionId === connectionId) ?? null
  const others = live.filter(i => i.kind === 'other')
  const deposits = live.filter(i => i.kind === 'deposit_held')
  const refresh = (view: OpeningView) => { qc.setQueryData('books-opening', view); qc.invalidateQueries('books-settings') }

  const setUpChart = async () => {
    setSettingUp(true)
    try {
      const r = await post<OpeningView>('/books/setup/opening-balances/chart')
      refresh(r.data)
      toast('Your chart of accounts is set up.')
    } catch (ex: any) {
      toast.error(ex.response?.data?.error || 'Could not set up the chart of accounts.')
    } finally {
      setSettingUp(false)
    }
  }

  const voidButton = (item: OpeningItem) => data.canEdit
    ? <button type="button" className="btn bd bsm" onClick={() => setDialog({ kind: 'void', item })}>Void</button>
    : null

  return (
    <div>
      <div className="ph">
        <div>
          <h1 className="pt">🧮 Opening Balances</h1>
          <p className="ps">What your books start with on {day(start)}. Enter what GAM has no record of; GAM works out the rest.</p>
        </div>
      </div>

      {!data.canEdit && <div className="alert agold">Only the owner enters opening balances.</div>}
      {data.closedThrough && (
        <div className="alert aw">Your books are closed through {day(data.closedThrough)}. A change here shows in the first open month, labeled as a correction.</div>
      )}

      {data.seesBank && data.bankAccounts && (
        <Section title="Bank accounts" help={<>Each account&apos;s balance at the start of {day(start)}. The suggestion is today&apos;s balance less what the bank feed shows since then — check it against your statement.</>}>
          {data.bankAccounts.length === 0 ? (
            <div className="empty" style={{ padding: '18px 10px' }}>No bank accounts are linked. Enter cash or an account GAM does not see under Other balances.</div>
          ) : (
            <Scroll>
              <table className="tbl" style={{ minWidth: 520 }}>
                <thead><tr><th>Account</th><th style={{ textAlign: 'right' }}>Suggested</th><th style={{ textAlign: 'right' }}>Entered</th><th></th></tr></thead>
                <tbody>
                  {data.bankAccounts.map(b => {
                    const cur = liveBank(b.id)
                    return (
                      <tr key={b.id}>
                        <td style={{ color: 'var(--t0)' }}>{b.name}{b.status === 'disconnected' && <span className="badge bmu" style={{ marginLeft: 6 }}>Disconnected</span>}</td>
                        <td className="mono" style={{ textAlign: 'right', color: 'var(--t3)' }}>{b.suggested != null ? money(b.suggested) : '—'}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{cur ? <>{money(cur.amount)}{cur.stale && <Stale />}</> : <span style={{ color: 'var(--t3)' }}>Not entered</span>}</td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {data.canEdit && <button type="button" className="btn bp bsm" onClick={() => setDialog({ kind: 'bank', account: b, current: cur })}>{cur ? 'Change' : 'Enter balance'}</button>}
                          {cur && <span style={{ marginLeft: 6 }}>{voidButton(cur)}</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </Scroll>
          )}
        </Section>
      )}

      <Section title="Other balances"
        help="Cash on hand, an account GAM does not see, a loan you owe, equipment — what each account held on your start date. Enter what an asset holds, or a liability owes, as a positive amount."
        action={data.canEdit && data.chartReady ? <button type="button" className="btn bp bsm" onClick={() => setDialog({ kind: 'other' })}>+ Add a balance</button> : null}>
        {!data.chartReady && data.canEdit && (
          <div className="alert agold" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ flex: 1, minWidth: 200 }}>Your books need their chart of accounts set up before you can name an account here.</span>
            <button type="button" className="btn bp bsm" disabled={settingUp} onClick={setUpChart}>{settingUp ? <><span className="spinner" />Setting up…</> : 'Set up the chart of accounts'}</button>
          </div>
        )}
        {others.length === 0 ? (
          <div className="empty" style={{ padding: '18px 10px' }}>None entered.</div>
        ) : (
          <Scroll>
            <table className="tbl" style={{ minWidth: 480 }}>
              <thead><tr><th>Account</th><th>Note</th><th style={{ textAlign: 'right' }}>Balance</th><th></th></tr></thead>
              <tbody>
                {others.map(i => (
                  <tr key={i.id}>
                    <td style={{ color: 'var(--t0)' }}>{i.accountCode} {i.accountName}<span style={{ color: 'var(--t3)', fontSize: '.7rem', marginLeft: 6 }}>{accountTypeLabel(i.accountType)}</span>{i.stale && <Stale />}</td>
                    <td style={{ fontSize: '.75rem', color: 'var(--t3)' }}>{i.memo ?? '—'}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{money(i.amount)}</td>
                    <td style={{ textAlign: 'right' }}>{voidButton(i)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        )}
      </Section>

      <Section title="Deposits you hold from before GAM"
        help="Security deposits tenants paid you before GAM that you still hold. Only if you want them on your books — leave this empty to keep them off GAM."
        action={data.canEdit ? <button type="button" className="btn bp bsm" onClick={() => setDialog({ kind: 'deposit' })}>+ Add a deposit</button> : null}>
        {deposits.length === 0 ? (
          <div className="empty" style={{ padding: '18px 10px' }}>None entered.</div>
        ) : (
          <Scroll>
            <table className="tbl" style={{ minWidth: 520 }}>
              <thead><tr><th>Tenant</th><th>Home</th><th>Paid</th><th style={{ textAlign: 'right' }}>Deposit</th><th></th></tr></thead>
              <tbody>
                {deposits.map(i => (
                  <tr key={i.id}>
                    <td style={{ color: 'var(--t0)' }}>{i.tenantName ?? '—'}{i.stale && <Stale />}</td>
                    <td style={{ fontSize: '.75rem' }}>{home(i.unitLabel, i.propertyName)}</td>
                    <td style={{ fontSize: '.75rem' }}>{day(i.paidOn)}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{money(i.amount)}</td>
                    <td style={{ textAlign: 'right' }}>{voidButton(i)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        )}
      </Section>

      <Section title="Home sales still owed"
        help={<>Worked out from your contracts: what was financed, less the principal of every payment billed before {day(start)}, paid through GAM or before it. {
          data.homeSaleMethod === 'whole_sale_at_signing' ? 'These open as notes owed to you.'
            : data.homeSaleMethod === 'income_as_paid' ? 'They are not on your balance sheet; each payment counts as income when it comes in.'
              : <>Choose how home sales count on {settingsLink} to see how these open.</>}</>}>
        {data.homeSales.length === 0 ? (
          <div className="empty" style={{ padding: '18px 10px' }}>No home sold before your start date is still owed.</div>
        ) : (
          <Scroll>
            <table className="tbl" style={{ minWidth: 640 }}>
              <thead><tr><th>Buyer</th><th>Home</th><th style={{ textAlign: 'right' }}>Financed</th><th style={{ textAlign: 'right' }}>Principal paid down</th><th style={{ textAlign: 'right' }}>Still owed</th><th style={{ textAlign: 'right' }}>Billed, unpaid</th></tr></thead>
              <tbody>
                {data.homeSales.map(h => (
                  <tr key={h.contractId}>
                    <td style={{ color: 'var(--t0)' }}>{h.buyerName}</td>
                    <td style={{ fontSize: '.75rem' }}>{home(h.unitLabel, h.propertyName)}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{money(h.financed)}</td>
                    <td className="mono" style={{ textAlign: 'right' }}>{money(h.principalBeforeStart)}</td>
                    <td className="mono" style={{ textAlign: 'right', color: 'var(--t0)', fontWeight: 600 }}>{money(h.stillOwed)}</td>
                    <td className="mono" style={{ textAlign: 'right', color: Number(h.billedUnpaid) ? 'var(--amber)' : 'var(--t3)' }}>{money(h.billedUnpaid)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Scroll>
        )}
        <p className="bnote">Something wrong here? Fix the contract or its payment history; this follows from them.</p>
      </Section>

      {voided.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <button type="button" className="btn bg-btn bsm" onClick={() => setShowVoided(v => !v)}>{showVoided ? 'Hide' : 'Show'} voided entries ({voided.length})</button>
          {showVoided && (
            <div className="card" style={{ marginTop: 10 }}>
              <Scroll>
                <table className="tbl" style={{ minWidth: 520 }}>
                  <thead><tr><th>Entry</th><th style={{ textAlign: 'right' }}>Amount</th><th>Voided</th><th>Why</th></tr></thead>
                  <tbody>
                    {voided.map(i => (
                      <tr key={i.id} style={{ opacity: 0.75 }}>
                        <td>{i.kind === 'bank' ? i.bankName : i.kind === 'other' ? `${i.accountCode ?? ''} ${i.accountName ?? ''}` : `Deposit · ${i.tenantName ?? '—'}`}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{money(i.amount)}</td>
                        <td style={{ fontSize: '.75rem' }}>{day(i.voidedAt?.slice(0, 10))}</td>
                        <td style={{ fontSize: '.75rem', color: 'var(--t3)' }}>{i.voidReason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            </div>
          )}
        </div>
      )}

      {dialog?.kind === 'bank' && <BankDialog start={start} account={dialog.account} current={dialog.current} onClose={() => setDialog(null)} onSaved={v => { refresh(v); setDialog(null); toast('Bank balance saved.') }} />}
      {dialog?.kind === 'other' && <OtherDialog start={start} accounts={data.accounts} onClose={() => setDialog(null)} onSaved={v => { refresh(v); setDialog(null); toast('Opening balance saved.') }} />}
      {dialog?.kind === 'deposit' && <DepositDialog start={start} leases={data.leases} onClose={() => setDialog(null)} onSaved={v => { refresh(v); setDialog(null); toast('Deposit saved.') }} />}
      {dialog?.kind === 'void' && <VoidDialog item={dialog.item} onClose={() => setDialog(null)} onSaved={v => { refresh(v); setDialog(null); toast('Voided. It stays on record.') }} />}
    </div>
  )
}

// ── The forms ─────────────────────────────────────────────────────────

function useSave(onSaved: (v: OpeningView) => void) {
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const run = async (url: string, body: object) => {
    setSaving(true); setErr('')
    try {
      const r = await post<OpeningView>(url, body)
      onSaved(r.data)
    } catch (ex: any) {
      setErr(ex.response?.data?.error || 'Could not save it.')
    } finally {
      setSaving(false)
    }
  }
  return { saving, err, setErr, run }
}

function Actions({ saving, label, onClose, danger }: { saving: boolean; label: string; onClose: () => void; danger?: boolean }) {
  return (
    <div className="factions">
      <button type="button" className="btn bg-btn" onClick={onClose}>Cancel</button>
      <button type="submit" className={`btn ${danger ? 'bd' : 'bp'}`} disabled={saving}>{saving ? <><span className="spinner" />Saving…</> : label}</button>
    </div>
  )
}

function BankDialog({ start, account, current, onClose, onSaved }: {
  start: string; account: BankAccount; current: OpeningItem | null; onClose: () => void; onSaved: (v: OpeningView) => void
}) {
  const [amount, setAmount] = useState(current?.amount ?? account.suggested ?? '')
  const [memo, setMemo] = useState('')
  const { saving, err, setErr, run } = useSave(onSaved)
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (String(amount).trim() === '') { setErr('Enter the balance.'); return }
    run('/books/setup/opening-balances', { kind: 'bank', bankConnectionId: account.id, amount, memo: memo || undefined })
  }
  return (
    <Modal title={`Balance on ${longCalendarDate(start)}`} onClose={onClose}>
      {err && <div className="alert ae">{err}</div>}
      <form onSubmit={submit}>
        <p style={{ fontSize: '.8rem', color: 'var(--t2)', marginTop: 0 }}>{account.name}: what the account held at the start of the day. Enter a negative amount if it was overdrawn.</p>
        {account.suggested != null && (
          <p className="bnote" style={{ marginTop: 0 }}>Suggested from the bank feed: {money(account.suggested)}. Check it against your statement.</p>
        )}
        {current && <p className="bnote" style={{ marginTop: 0 }}>This replaces the {money(current.amount)} entered before; that entry stays on record as replaced.</p>}
        <div className="frow"><label htmlFor="ob-bank-amt">Balance</label><input id="ob-bank-amt" type="text" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" required /></div>
        <div className="frow"><label htmlFor="ob-bank-memo">Note (optional)</label><input id="ob-bank-memo" type="text" maxLength={500} value={memo} onChange={e => setMemo(e.target.value)} placeholder="e.g. From the July statement" /></div>
        <Actions saving={saving} label="Save balance" onClose={onClose} />
      </form>
    </Modal>
  )
}

function OtherDialog({ start, accounts, onClose, onSaved }: {
  start: string; accounts: AccountOption[]; onClose: () => void; onSaved: (v: OpeningView) => void
}) {
  const [accountId, setAccountId] = useState('')
  const [amount, setAmount] = useState('')
  const [memo, setMemo] = useState('')
  const { saving, err, setErr, run } = useSave(onSaved)
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!accountId) { setErr('Choose the account.'); return }
    run('/books/setup/opening-balances', { kind: 'other', accountId, amount, memo: memo || undefined })
  }
  return (
    <Modal title="Add an opening balance" onClose={onClose}>
      {err && <div className="alert ae">{err}</div>}
      <form onSubmit={submit}>
        <p style={{ fontSize: '.8rem', color: 'var(--t2)', marginTop: 0 }}>What the account held on {longCalendarDate(start)}. Receivables, money GAM holds and deposits owed are not listed — they open from GAM&apos;s own records.</p>
        <div className="frow">
          <label htmlFor="ob-acct">Account</label>
          <select id="ob-acct" value={accountId} onChange={e => setAccountId(e.target.value)} required>
            <option value="">Choose an account…</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.code} {a.name} ({accountTypeLabel(a.type)})</option>)}
          </select>
        </div>
        <div className="frow"><label htmlFor="ob-amt">Balance</label><input id="ob-amt" type="text" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" required /></div>
        <div className="frow"><label htmlFor="ob-memo">Note (optional)</label><input id="ob-memo" type="text" maxLength={500} value={memo} onChange={e => setMemo(e.target.value)} placeholder="e.g. Cash box at the office" /></div>
        <Actions saving={saving} label="Save balance" onClose={onClose} />
      </form>
    </Modal>
  )
}

function DepositDialog({ start, leases, onClose, onSaved }: {
  start: string; leases: LeaseOption[]; onClose: () => void; onSaved: (v: OpeningView) => void
}) {
  const [leaseId, setLeaseId] = useState('')
  const [amount, setAmount] = useState('')
  const [paidOn, setPaidOn] = useState('')
  const [memo, setMemo] = useState('')
  const { saving, err, setErr, run } = useSave(onSaved)
  const chosen = leases.find(l => l.leaseId === leaseId) ?? null
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!leaseId) { setErr('Choose the tenant\'s lease.'); return }
    if (!paidOn) { setErr('Enter the day the tenant paid the deposit.'); return }
    run('/books/setup/opening-balances', { kind: 'deposit_held', leaseId, amount, paidOn, memo: memo || undefined })
  }
  return (
    <Modal title="Add a deposit you hold" onClose={onClose}>
      {err && <div className="alert ae">{err}</div>}
      <form onSubmit={submit}>
        <p style={{ fontSize: '.8rem', color: 'var(--t2)', marginTop: 0 }}>A security deposit a tenant paid you on or before {longCalendarDate(start)} that you still hold.</p>
        <div className="frow">
          <label htmlFor="ob-lease">Tenant</label>
          <select id="ob-lease" value={leaseId} onChange={e => setLeaseId(e.target.value)} required>
            <option value="">Choose a tenant…</option>
            {leases.map(l => <option key={l.leaseId} value={l.leaseId}>{l.tenantName ?? 'No tenant named'} — {l.unitLabel} · {l.propertyName}</option>)}
          </select>
        </div>
        {chosen?.gamDeposit && (
          <div className="alert aw">GAM already has a {money(chosen.gamDeposit)} deposit on this lease. Enter only money GAM has no record of.</div>
        )}
        <div className="frow2">
          <div><label htmlFor="ob-dep-amt">Deposit</label><input id="ob-dep-amt" type="text" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" required /></div>
          <div><label htmlFor="ob-dep-paid">Day it was paid</label><input id="ob-dep-paid" type="date" max={start} value={paidOn} onChange={e => setPaidOn(e.target.value)} required /></div>
        </div>
        <div className="frow"><label htmlFor="ob-dep-memo">Note (optional)</label><input id="ob-dep-memo" type="text" maxLength={500} value={memo} onChange={e => setMemo(e.target.value)} /></div>
        <Actions saving={saving} label="Save deposit" onClose={onClose} />
      </form>
    </Modal>
  )
}

function VoidDialog({ item, onClose, onSaved }: { item: OpeningItem; onClose: () => void; onSaved: (v: OpeningView) => void }) {
  const [reason, setReason] = useState('')
  const { saving, err, setErr, run } = useSave(onSaved)
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!reason.trim()) { setErr('Say why it is being voided.'); return }
    run(`/books/setup/opening-balances/${item.id}/void`, { reason: reason.trim() })
  }
  return (
    <Modal title="Void this opening balance?" onClose={onClose}>
      {err && <div className="alert ae">{err}</div>}
      <form onSubmit={submit}>
        <p style={{ fontSize: '.8rem', color: 'var(--t2)', marginTop: 0 }}>{money(item.amount)} comes out of what your books start with. The entry stays on record as voided, with your reason.</p>
        <div className="frow"><label htmlFor="ob-void">Why</label><textarea id="ob-void" rows={2} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} required /></div>
        <Actions saving={saving} label="Void" onClose={onClose} danger />
      </form>
    </Modal>
  )
}
