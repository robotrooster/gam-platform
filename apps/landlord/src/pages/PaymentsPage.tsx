import { Fragment, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from 'react-query'
import { TENANT_CREDIT_CATEGORIES, TENANT_CREDIT_CATEGORY_LABEL, declaredDateFlagText } from '@gam/shared'
import { apiGet, apiPost } from '../lib/api'
import { usePerms } from '../lib/permissions'
import { useAuth } from '../context/AuthContext'
import { SearchBox } from '../components/ListControls'
import { X, CheckCircle, Gift } from 'lucide-react'
import {
  money, toCents, monthTitle, dayWord, readShowLineItems, writeShowLineItems, ledgerMatches, stillOweLine,
  serverStatus, serverMessage, returnDetail, chargeMonthsRange, readChargesById, CHARGE_PAGE_SIZE,
  ZERO_TOLERANCE_TEXT, CREDIT_TAKEN_BACK_TEXT, CREDIT_USE_RULE,
  type LedgerPayment, type ReturnFacts,
} from '../lib/creditDesk'
import '../styles/credit-desk.css'

// 10/5 (Nic): the photo of a bank's receipt on a payment (its own file, so the
// bank review shows the tenant's photo without loading this page).
export { BankReceiptPhoto } from '../components/BankReceiptPhoto'
import { BankReceiptPhoto } from '../components/BankReceiptPhoto'

// ── THE PAYMENTS TAB: PAYMENTS ALREADY MADE, BY MONTH ──────────────────────
//
// Decisions #29 (Nic, 10/3 — replaces #28): "PAYMENTS tab = a ledger of
// payments that have already happened, STAMPED BY MONTH: one section per month,
// newest first, with a month picker to jump back (not one endless list) ... One
// line per payment per #26 ... 'Show line items' toggle remembered per person.
// Work-trade households get one line per month 'Work trade — covered' (no
// amount) so the month reads complete. Bank payments still clearing are listed
// and marked 'clearing'; a returned one is marked 'returned'. A month total
// shows only to owners / property managers (#25). The Payments tab loses its
// Record payment button and its duplicate outstanding table; the current month
// shows one plain pointer line 'N households still owe — see Outstanding
// Balances' (a count, no dollars)."
//
// #35.1 / #36.A: a payment is filed under the month of the BILL it paid (a
// September bill paid Oct 3 is under September, "paid Oct 3, 2 days late"); a
// payment that paid several months' bills shows under each with its part; a
// bill paid from paid-ahead credit shows "Paid from credit" on the day it was
// applied. The server decides all of that (services/paymentsByMonth); this
// page lays it out.
//
// WHO (S641, kept by #29): owners, property managers and staff with "View all
// payments". Anyone else is pointed to Outstanding Balances, where money is
// taken. The server refuses them too.

interface LedgerLine {
  paymentId: string
  label: string
  detail: string | null
  dueDate: string
  amount: number
  paid: number
  credit: number
  returned: number
  /**
   * Of `credit`, paid-ahead credit whose own money a card dispute or bank
   * return took back after it paid this charge (the charge is owed again for
   * it). Beside `credit`, never inside `returned` (fix pass 2).
   */
  creditReturned: number
  unitNumber: string | null
  propertyName: string | null
}
interface LedgerRow extends LedgerPayment {
  kind: 'receipt' | 'credit' | 'settled'
  arrivedOn: string | null
  method: string | null
  lines: LedgerLine[]
}
interface PaymentsMonth {
  month: string
  months: string[]
  payments: LedgerRow[]
  workTrade: Array<{ tenantId: string; name: string; unitNumber: string | null; propertyName: string | null; label: string }>
  stillOweHouseholds: number | null
  /**
   * decisions #25: owners and property managers only. `paidFromCredit` is the
   * credit that still stands; credit whose money was taken back since is
   * `creditReturnedSince`, beside it (services/paymentsByMonth LedgerTotals).
   */
  totals?: { paid: number; paidFromCredit: number; returnedSince: number; creditReturnedSince: number; clearing: number; payments: number }
}

const STATUS_BADGE: Record<LedgerRow['status'], string> = {
  settled: 'badge-green',
  clearing: 'badge-blue',
  returned: 'badge-red',
}

// S577: landlord issues a credit to a tenant (screening cap, late-fee refund,
// overcharge, goodwill). Funded by the landlord (they receive less rent) and
// never income. S655 (Nic, 10/2): it sits on their account — offered when they
// pay, and it pays a bill by itself only when it covers that whole bill.
function IssueCreditModal({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const { data: leases = [] } = useQuery<any[]>('leases', () => apiGet('/leases'))
  const activeLeases = (leases as any[]).filter((l: any) => l.status === 'active')
  const [leaseId, setLeaseId] = useState('')
  // S652 (Nic): "searchable name — matched to a lease." Nobody knows a spot
  // number cold; they know who is standing at the counter.
  const [who, setWho] = useState('')
  const personLabel = (l: any) => {
    const names = (l.tenants ?? []).map((t: any) => `${t.firstName ?? ''} ${t.lastName ?? ''}`.trim()).filter(Boolean)
    return `${names.join(' & ') || 'No tenant on file'} · ${l.unitNumber || 'Unit'}${l.propertyName ? ` · ${l.propertyName}` : ''}`
  }
  const q = who.trim().toLowerCase()
  const matches = q.length < 2 ? [] : activeLeases.filter((l: any) => personLabel(l).toLowerCase().includes(q)).slice(0, 8)
  const picked = activeLeases.find((l: any) => l.id === leaseId)
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState<string>('goodwill')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const mut = useMutation(
    () => apiPost('/tenant-credits', { leaseId, amount: Number(amount), category, reason: reason || null }),
    // The server says what the credit did (paid the whole open bill, or is on
    // their account and how much in all); the old line stays as the fallback.
    { onSuccess: (r: any) => onDone(r?.data?.message ?? r?.message ?? `Credit of ${money(Number(amount))} issued. ${CREDIT_USE_RULE}`),
      onError: (e: any) => setError(serverMessage(e, 'Could not issue the credit')) })
  const valid = leaseId && amount !== '' && Number(amount) > 0
  // Like the desk window: only its own buttons close it, and not while the
  // credit is being issued (the result is always said).
  const close = () => { if (!mut.isLoading) onClose() }
  return (
    <div className="modal-overlay">
      <div className="modal cd-window">
        <div className="cd-head">
          <div className="modal-title cd-title"><Gift size={17} style={{ color: 'var(--gold)', verticalAlign: '-3px' }} /> Issue credit</div>
          <div className="cd-sub">
            It sits on their account. {CREDIT_USE_RULE} You receive that much less rent when it is used. Use it for a
            refund, an overcharge correction, a capped-state screening difference, or goodwill.
          </div>
        </div>
        <div className="cd-window-body">
          <div className="cd-field">
            <span className="cd-field-label">Who</span>
            {picked ? (
              <div className="cd-person">
                <span className="cd-strong">{personLabel(picked)}</span>
                <button type="button" className="cd-x" aria-label="Remove and pick someone else" disabled={mut.isLoading}
                  onClick={() => { setLeaseId(''); setWho('') }}>×</button>
              </div>
            ) : (
              <>
                <input className="form-input" autoFocus value={who} onChange={e => setWho(e.target.value)}
                  placeholder="Type a name, space number or property…" />
                {matches.length > 0 && (
                  <div className="cd-picker-results">
                    {matches.map((l: any) => (
                      <button key={l.id} type="button" className="cd-picker-item" onClick={() => setLeaseId(l.id)}>
                        {personLabel(l)}
                      </button>
                    ))}
                  </div>
                )}
                {q.length >= 2 && matches.length === 0 && (
                  <div className="cd-muted">No active lease matches that.</div>
                )}
              </>
            )}
          </div>
          <div className="cd-choice">
            <label className="cd-field">
              <span className="cd-field-label">Amount ($)</span>
              <input className="form-input mono" type="text" inputMode="decimal" value={amount}
                onChange={e => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setAmount(v) }}
                placeholder="0.00" />
            </label>
            <label className="cd-field">
              <span className="cd-field-label">Reason</span>
              <select className="form-select" value={category} onChange={e => setCategory(e.target.value)}>
                {TENANT_CREDIT_CATEGORIES.map(c => <option key={c} value={c}>{TENANT_CREDIT_CATEGORY_LABEL[c]}</option>)}
              </select>
            </label>
          </div>
          <label className="cd-field">
            <span className="cd-field-label">Note (optional)</span>
            <input className="form-input" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. refunded May late fee" />
          </label>
          {error && <div className="alert alert-danger cd-msg">{error}</div>}
        </div>
        <div className="cd-actions cd-footer">
          <button className="btn btn-primary cd-grow" disabled={!valid || mut.isLoading} onClick={() => { setError(null); mut.mutate() }}>
            {mut.isLoading ? 'Issuing…' : 'Issue credit'}
          </button>
          <button className="btn btn-ghost" disabled={mut.isLoading} onClick={close}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

export function PaymentsPage() {
  const navigate = useNavigate()
  const { can, isOwner } = usePerms()
  const { user } = useAuth()
  const role = user?.role
  const seesLedger = can('payments.view_all')
  const [month, setMonth] = useState<string | null>(null)
  const { data, isLoading, error, refetch, isFetching } = useQuery<PaymentsMonth>(
    ['payments-ledger', month ?? 'current'],
    () => apiGet<PaymentsMonth>(`/balances/payments-by-month${month ? `?month=${month}` : ''}`),
    { enabled: seesLedger, keepPreviousData: true, retry: (n: number, e: unknown) => serverStatus(e) !== 403 && n < 2 })
  // decisions #26: "a toggle shows the line-item breakdown; each person's choice is remembered."
  const [showItems, setShowItems] = useState(() => readShowLineItems(user?.id))
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set())
  const toggleOne = (id: string) => setOpenIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  const [search, setSearch] = useState('')
  const [creditOpen, setCreditOpen] = useState(false)
  const [creditNotice, setCreditNotice] = useState<string | null>(null)

  const refused = serverStatus(error) === 403

  // WHY A PAYMENT CAME BACK (S655 review): the bank's return code, in words,
  // and the zero-tolerance mark (the bank said the debit was not authorized, so
  // bank payments from that person are stopped). The old payment detail window
  // showed them; the ledger by month does not carry them, so they are read for
  // the charges a returned payment paid from the payments list — the same
  // viewers, and only in a month that has something returned.
  // Fix round 2: the list is read page by page until every returned charge is
  // found (a month of a large portfolio is more than one 1,000-charge page), and
  // the page says so if the page limit ever stops it short.
  const returnedLines = (data?.payments ?? [])
    .filter(p => p.status === 'returned' || toCents(p.returned) > 0)
    .flatMap(p => p.lines)
  const returnRange = chargeMonthsRange(returnedLines.map(l => l.dueDate))
  const wantedReturnIds = [...new Set(returnedLines.map(l => l.paymentId).filter(Boolean))].sort()
  const { data: returnRead } = useQuery<{ rows: Array<ReturnFacts & { id: string }>; complete: boolean }>(
    ['payments-returns', returnRange?.from ?? '', returnRange?.to ?? '', wantedReturnIds.join(',')],
    () => readChargesById<ReturnFacts & { id: string }>(
      page => apiGet(`/payments?from=${returnRange!.from}&to=${returnRange!.to}&limit=${CHARGE_PAGE_SIZE}&page=${page}`),
      new Set(wantedReturnIds)),
    { enabled: seesLedger && !refused && !!returnRange && wantedReturnIds.length > 0, staleTime: 60_000, retry: false })
  const returnRows = returnRead?.rows ?? []
  const returnsIncomplete = returnRead?.complete === false
  const returnsById = new Map<string, NonNullable<ReturnType<typeof returnDetail>>>()
  for (const r of returnRows) {
    const d = returnDetail(r)
    if (d && r.id) returnsById.set(r.id, d)
  }
  const paymentReturns = (p: LedgerRow) => {
    const seen = new Map<string, NonNullable<ReturnType<typeof returnDetail>>>()
    for (const l of p.lines) {
      const d = returnsById.get(l.paymentId)
      if (d && !seen.has(d.text)) seen.set(d.text, d)
    }
    return [...seen.values()]
  }
  const header = (
    <div className="page-header">
      <div>
        <h1 className="page-title">Payments</h1>
        <p className="page-subtitle">Payments already made, filed under the month of the bill they paid</p>
      </div>
      <div className="cd-actions">
        {/* S641: issuing credit is an owner / property manager act — the route
            refuses anyone else, so nobody else sees the button. */}
        {(isOwner || role === 'property_manager') && (
          <button className="btn btn-primary" onClick={() => setCreditOpen(true)}>
            <Gift size={15} /> Issue credit
          </button>
        )}
        {can('payments.import_history') && (
          <button className="btn btn-primary" onClick={() => navigate('/payment-history-onboarding')}>
            Import payment history
          </button>
        )}
      </div>
    </div>
  )
  const modals = creditOpen && (
    <IssueCreditModal onClose={() => setCreditOpen(false)}
      onDone={(msg) => { setCreditOpen(false); setCreditNotice(msg) }} />
  )

  if (!seesLedger || refused) {
    // Where to go from here, for exactly the switches this person has.
    const opensBalances = can('balances.view')
    const takesPayments = can('take_payment')
    return (
      <div>
        {header}
        <div className="card cd-empty">
          <p className="cd-msg">
            Payments already made are shown to owners, property managers and staff allowed to see all payments.
            {opensBalances
              ? ' To take a payment, use Outstanding Balances.'
              : takesPayments
                ? ' Payments are taken on Outstanding Balances, which your account cannot open yet. Ask the account owner to turn on “View who owes + contact” for you under Team.'
                : ' If you need to see payments, ask the account owner.'}
          </p>
          {opensBalances && (
            <button className="btn btn-primary btn-sm" onClick={() => navigate('/balances')}>Open Outstanding Balances</button>
          )}
        </div>
        {modals}
      </div>
    )
  }

  const shownMonth = data?.month ?? month ?? ''
  const year = shownMonth.slice(0, 4)
  const payments = (data?.payments ?? []).filter(p => ledgerMatches(p, search))
  const workTrade = (data?.workTrade ?? []).filter(w => ledgerMatches({ name: w.name, unitNumber: w.unitNumber, propertyName: w.propertyName, paidFor: '' }, search))
  const pointer = stillOweLine(data?.stillOweHouseholds)
  const t = data?.totals

  return (
    <div>
      {header}

      {creditNotice && (
        <div className="alert alert-success cd-notice" role="status">
          <CheckCircle size={15} />
          <span>{creditNotice}</span>
          <button className="btn btn-ghost btn-sm" aria-label="Dismiss" onClick={() => setCreditNotice(null)}><X size={13} /></button>
        </div>
      )}

      <div className="cd-ledger-bar">
        <select className="form-select cd-month-select" aria-label="Month" value={shownMonth}
          onChange={e => { setMonth(e.target.value); setOpenIds(new Set()) }}>
          {(data?.months ?? (shownMonth ? [shownMonth] : [])).map(m => <option key={m} value={m}>{monthTitle(m)}</option>)}
        </select>
        <SearchBox value={search} onChange={setSearch} placeholder="Search name, space, what it paid for…" />
        <label className="cd-toggle">
          <input type="checkbox" checked={showItems}
            onChange={e => { setShowItems(e.target.checked); writeShowLineItems(user?.id, e.target.checked); setOpenIds(new Set()) }} />
          Show line items
        </label>
      </div>

      {isLoading ? (
        <div className="card cd-empty">Loading…</div>
      ) : error ? (
        <div className="card cd-empty">
          <p className="cd-msg">{serverMessage(error, 'The payments could not be read.')}</p>
          <button className="btn btn-primary btn-sm" disabled={isFetching} onClick={() => refetch()}>{isFetching ? 'Reading…' : 'Read them again'}</button>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
          <div className="cd-month-head">
            <h2 className="cd-month-title">{monthTitle(shownMonth)}</h2>
            <span className="cd-line-meta">{data?.payments.length ?? 0} payment{(data?.payments.length ?? 0) === 1 ? '' : 's'} on this month&apos;s bills</span>
            {/* decisions #25: the month total exists only when the server sent it (owners, property managers). */}
            {t && (
              <div className="cd-totals">
                <span>Paid <strong>{money(t.paid)}</strong></span>
                {t.paidFromCredit > 0 && <span>From credit <strong>{money(t.paidFromCredit)}</strong></span>}
                {/* Fix pass 2: credit a dispute or bank return took back is not in "From
                    credit" (every dollar counted once) — said beside it, so the
                    rows below add up. */}
                {toCents(t.creditReturnedSince) > 0 && <span>Credit taken back since <strong>{money(t.creditReturnedSince)}</strong></span>}
                {t.clearing > 0 && <span>Still clearing <strong>{money(t.clearing)}</strong></span>}
                {t.returnedSince > 0 && <span>Taken back since <strong>{money(t.returnedSince)}</strong></span>}
              </div>
            )}
          </div>
          {pointer && (
            <div className="cd-pointer">
              <span>{pointer}</span>
              <button className="btn btn-primary btn-sm" onClick={() => navigate('/balances')}>Open Outstanding Balances</button>
            </div>
          )}
          {returnsIncomplete && (
            <div className="cd-note cd-pointer">
              Some returned payments this month may show no reason — the month has too many charges to read them all
              here. GAM support can tell you why any of them came back.
            </div>
          )}
          {payments.length === 0 && workTrade.length === 0 ? (
            <div className="cd-empty">
              {search ? 'No payment this month matches that.' : 'No payments on this month’s bills yet.'}
            </div>
          ) : (
            <table className="data-table" style={{ minWidth: 980 }}>
              <thead>
                <tr>
                  <th>Paid</th><th>Who</th><th>Space</th><th>For</th>
                  <th style={{ textAlign: 'right' }}>Owed</th><th style={{ textAlign: 'right' }}>Paid</th>
                  <th>How</th><th>On time</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {payments.map(p => {
                  const open = showItems || openIds.has(p.id)
                  const creditOnly = toCents(p.amount) === 0 && toCents(p.creditApplied) > 0
                  return (
                    <Fragment key={p.id}>
                      <tr className="cd-ledger-row" onClick={() => toggleOne(p.id)} title={open ? 'Hide the charges' : 'Show the charges it paid'}>
                        <td className="mono">
                          {dayWord(p.paidOn, year)}
                          {p.arrivedOn && p.arrivedOn !== p.paidOn && <div className="cd-ledger-sub">arrived {dayWord(p.arrivedOn, year)}</div>}
                        </td>
                        <td>{p.name}</td>
                        <td>
                          {p.unitNumber || '—'}
                          {p.propertyName && <div className="cd-ledger-sub">{p.propertyName}</div>}
                        </td>
                        <td>{p.paidFor}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{money(p.owed)}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>
                          {creditOnly ? <span className="cd-ledger-sub">from credit</span> : money(p.amount)}
                          {!creditOnly && toCents(p.creditApplied) > 0 && <div className="cd-ledger-sub">+ {money(p.creditApplied)} from credit</div>}
                          {creditOnly && <div>{money(p.creditApplied)}</div>}
                          {toCents(p.returned) > 0 && <div className="cd-ledger-sub cd-timing-late">{money(p.returned)} taken back</div>}
                          {toCents(p.creditReturned) > 0 && <div className="cd-ledger-sub cd-timing-late">{money(p.creditReturned)} credit taken back</div>}
                        </td>
                        <td>
                          {p.methodLabel}
                          {p.reference && <div className="cd-ledger-sub">#{p.reference}</div>}
                          {p.method === 'bank_deposit' && (
                            <BankReceiptPhoto receiptId={p.receiptId} url={p.depositPhotoUrl}
                              canAdd={can('take_payment')} onAdded={() => refetch()} />
                          )}
                          {/* 10/5 (Nic): the tenant's report this deposit confirmed — their
                              photo, and the flag when the bank showed a later day. */}
                          {p.tenantReceiptPhotoUrl && (
                            <BankReceiptPhoto receiptId={p.receiptId} url={p.tenantReceiptPhotoUrl}
                              canAdd={false} onAdded={() => {}} label="Tenant's photo of the bank receipt" />
                          )}
                          {p.depositDateFlag && (
                            <div className="cd-ledger-sub cd-timing-late" role="note">
                              {declaredDateFlagText(p.depositDateFlag.said, p.depositDateFlag.bank)}
                            </div>
                          )}
                        </td>
                        <td className={p.daysLate > 0 ? 'cd-timing-late' : undefined}>{p.timingLabel}</td>
                        <td>
                          <span className={`badge ${STATUS_BADGE[p.status] ?? 'badge-muted'}`}>{p.statusLabel}</span>
                          {(p.status === 'returned' || toCents(p.returned) > 0) && (() => {
                            const why = paymentReturns(p)
                            return (<>
                              {why.map(d => <div key={d.text} className="cd-ledger-sub cd-return">{d.text}</div>)}
                              {why.some(d => d.zeroTolerance) && <div className="cd-ledger-sub cd-return cd-strong-sub">{ZERO_TOLERANCE_TEXT}</div>}
                            </>)
                          })()}
                          {/* The bill's own charges were not disputed: the payment that put
                              the credit on their account was. Said here, since no return
                              reason sits on these charges. */}
                          {toCents(p.creditReturned) > 0 && (
                            <div className="cd-ledger-sub cd-return">{CREDIT_TAKEN_BACK_TEXT}</div>
                          )}
                        </td>
                      </tr>
                      {open && p.lines.map(l => (
                        <tr key={`${p.id}:${l.paymentId}`} className="cd-ledger-items">
                          <td className="cd-ledger-indent mono">due {dayWord(l.dueDate, year)}</td>
                          <td colSpan={3}>
                            {l.label}{l.detail ? <span className="cd-ledger-sub"> · {l.detail}</span> : null}
                            {returnsById.get(l.paymentId) && (
                              <span className="cd-ledger-sub cd-return"> · {returnsById.get(l.paymentId)!.text}</span>
                            )}
                            {l.unitNumber && l.unitNumber !== p.unitNumber && <span className="cd-ledger-sub"> · {l.unitNumber}</span>}
                          </td>
                          <td className="mono" style={{ textAlign: 'right' }}>{money(l.amount)}</td>
                          <td className="mono" style={{ textAlign: 'right' }}>
                            {toCents(l.paid) > 0 && money(l.paid)}
                            {toCents(l.credit) > 0 && <div className="cd-ledger-sub">{money(l.credit)} from credit</div>}
                            {toCents(l.returned) > 0 && <div className="cd-ledger-sub cd-timing-late">{money(l.returned)} taken back</div>}
                            {toCents(l.creditReturned) > 0 && <div className="cd-ledger-sub cd-timing-late">{money(l.creditReturned)} credit taken back</div>}
                          </td>
                          <td colSpan={3}></td>
                        </tr>
                      ))}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          )}
          {/* #29: a work-trade household's month reads complete — never an amount. */}
          {workTrade.length > 0 && (
            <>
              <div className="cd-worktrade-head">Work trade</div>
              {workTrade.map(w => (
                <div key={w.tenantId} className="cd-worktrade-line">
                  {w.label} · {w.name}{w.unitNumber ? ` · ${w.unitNumber}` : ''}{w.propertyName ? ` · ${w.propertyName}` : ''}
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {modals}
    </div>
  )
}
