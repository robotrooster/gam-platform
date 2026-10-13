import { Fragment, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import {
  TENANT_CREDIT_CATEGORIES, TENANT_CREDIT_CATEGORY_LABEL, isSpaceOnlyRow,
  type OpenMonthRoll, type OpenMonthRow, type RentRollProperty,
} from '@gam/shared'
import { apiGet, apiPost } from '../lib/api'
import { usePerms } from '../lib/permissions'
import { useAuth } from '../context/AuthContext'
import { X, CheckCircle, Gift, ChevronRight } from 'lucide-react'
import { money, toCents, monthTitle, serverStatus, serverMessage, CREDIT_USE_RULE } from '../lib/creditDesk'
import { RecordPaymentWindow, PostPaymentForm } from '../components/RecordPaymentWindow'
import { OpenMonthDetail } from '../components/payments/OpenMonthDetail'
import { RecordPaymentPicker } from '../components/payments/RecordPaymentPicker'
import {
  propertyToShow, openProperties, householdName, reportPath, rowTakesPayment, paidWords, earlierWords,
} from '../components/payments/openMonth'
import '../styles/credit-desk.css'
import '../components/payments/payments.css'

// 10/5 (Nic): the photo of a bank's receipt on a payment (its own file, so the
// bank review shows the tenant's photo without loading this page).
export { BankReceiptPhoto } from '../components/BankReceiptPhoto'

// ── THE PAYMENTS PAGE: THE RENT ROLL FOR THE OPEN MONTH ─────────────────────
//
// 10/13 (Nic): "the payments page is the rent roll for the open month. And the
// rent roll page is the historical lookup for previous reportings ... you
// select either property and view only those properties ... in order of space
// number ... showing what was invoiced what was paid any difference in the
// balance if they make a partial payment ... I don't think we need to have the
// on time column at all. Like underneath paid, it can show ... a +5 showing
// days past grace ... The payment method is a fine column. And then We just
// need the invoiced amount paid and amount still owed if any ... for the open
// month I want it to be in order of space number but below any outstanding
// balances. So outstanding balances are always at the top of this list. And
// then once it's paid, it drops down and inserts itself in order of space
// number."
//
// Answered 10/13: pick the property first, every time — except a company with
// one property opens straight to it. One row per household (a lease), every
// space shown (an empty one a gray Vacant row; one in use with nobody on a
// lease says what is there — "Owner Use", a stay guest "Checked in" — never
// Vacant). Columns Space · Tenant · Invoiced · Paid · Owed · Payment method ·
// Status — no On time column. One status pill: green Paid, orange "Paid late
// +N", yellow Partial, red "Owes +N", gray "Due <date>", gray Vacant; work
// trade covering the month is Paid, method "Work trade", its value beside Paid
// as on the Rent Roll ("+ $X work trade"). Owed is this month's; what is still
// owed on earlier months shows under it, and keeps the row at the top until
// paid ("outstanding balances are always at the top"). Clicking the ROW opens
// each payment and every charge with what it's for; clicking the NAME opens
// the tenant report. Eviction mode shows on the row ("we have eviction mode
// that blocks payments"). "payments first. with a way to log the payments":
// the first Financials tab, and Record payment right here — the desk window
// and posting a payment ahead, the one way a payment is logged by hand.
//
// The server builds it all (GET /balances/rent-roll/properties and
// /rent-roll/open-month, services/rentRoll — owed rows first, each group in
// space order); this page lays it out and never re-sorts or re-judges a row.
// A sum across households is shown only when the server sent one (decisions
// #25: owners and property managers).
//
// WHO (S641, kept): owners, property managers and staff with "View all
// payments". Anyone else is pointed to Outstanding Balances, where money is
// taken. The server refuses them too.

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
  const qc = useQueryClient()
  const { can, isOwner } = usePerms()
  const { user } = useAuth()
  const role = user?.role
  const seesLedger = can('payments.view_all')
  const canTake = can('take_payment')
  const [params, setParams] = useSearchParams()
  const picked = params.get('property')

  const propsQ = useQuery<RentRollProperty[]>(
    ['payments-page', 'properties'], () => apiGet<RentRollProperty[]>('/balances/rent-roll/properties'),
    { enabled: seesLedger, retry: (n: number, e: unknown) => serverStatus(e) !== 403 && n < 2 })
  const properties = openProperties(propsQ.data)
  const propertyId = propsQ.data ? propertyToShow(picked, propsQ.data) : null
  // Under 'payments-ledger': the desk window and posting ahead refresh it
  // themselves the moment a payment is logged.
  const rollQ = useQuery<OpenMonthRoll>(
    ['payments-ledger', 'open-month', propertyId],
    () => apiGet<OpenMonthRoll>(`/balances/rent-roll/open-month?propertyId=${encodeURIComponent(propertyId ?? '')}`),
    { enabled: seesLedger && !!propertyId,
      retry: (n: number, e: unknown) => ![400, 403, 404].includes(serverStatus(e) ?? 0) && n < 2 })
  const roll = rollQ.data && rollQ.data.propertyId === propertyId ? rollQ.data : undefined
  const refused = serverStatus(propsQ.error) === 403 || serverStatus(rollQ.error) === 403

  // Which rows are open (the row's payments and charges underneath).
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set())
  const toggle = (key: string) => setOpenKeys(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  const pick = (id: string | null) => {
    setOpenKeys(new Set())
    setParams(id ? { property: id } : {})
  }

  // Logging a payment: the desk window on a row's open charge, the "who is
  // paying?" list, a payment posted ahead. One message at a time: the last thing
  // that happened (what the desk window recorded shows once it is closed).
  const [recording, setRecording] = useState<{ anchorId: string; tenantId: string | null; name: string } | null>(null)
  const [picking, setPicking] = useState(false)
  const [posting, setPosting] = useState<{ tenantId: string; name: string } | null>(null)
  const [creditOpen, setCreditOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const recorded = useRef<string | null>(null)
  const refresh = () => { void qc.invalidateQueries('payments-ledger') }
  const openRecord = (row: OpenMonthRow) => {
    if (!row.recordWith) return
    setNotice(null)
    // A new window starts with nothing recorded: an earlier window's words can
    // never surface when this one closes.
    recorded.current = null
    setRecording({ anchorId: row.recordWith, tenantId: row.householdId, name: householdName(row) })
  }
  const openAhead = (row: OpenMonthRow) => {
    if (!row.householdId) return
    setNotice(null)
    setPosting({ tenantId: row.householdId, name: householdName(row) })
  }

  const header = (
    <div className="page-header">
      <div>
        <h1 className="page-title">Payments</h1>
        <p className="page-subtitle">This month: invoiced, paid and still owed, one property at a time</p>
      </div>
      <div className="cd-actions">
        {/* S641: only for someone who can finish it (Take payments). */}
        {canTake && roll && !refused && (
          <button className="btn btn-primary" onClick={() => { setNotice(null); setPicking(true) }}>Record payment</button>
        )}
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
  const noticeBar = notice && (
    <div className="alert alert-success cd-notice" role="status">
      <CheckCircle size={15} />
      <span>{notice}</span>
      <button className="btn btn-ghost btn-sm" aria-label="Dismiss" onClick={() => setNotice(null)}><X size={13} /></button>
    </div>
  )
  const creditModal = creditOpen && (
    <IssueCreditModal onClose={() => setCreditOpen(false)}
      onDone={(msg) => { setCreditOpen(false); setNotice(msg); refresh() }} />
  )

  if (!seesLedger || refused) {
    // Where to go from here, for exactly the switches this person has.
    const opensBalances = can('balances.view')
    return (
      <div>
        {header}
        {noticeBar}
        <div className="card cd-empty">
          <p className="cd-msg">
            Payments already made are shown to owners, property managers and staff allowed to see all payments.
            {opensBalances
              ? ' To take a payment, use Outstanding Balances.'
              : canTake
                ? ' Payments are taken on Outstanding Balances, which your account cannot open yet. Ask the account owner to turn on “View who owes + contact” for you under Team.'
                : ' If you need to see payments, ask the account owner.'}
          </p>
          {opensBalances && (
            <button className="btn btn-primary btn-sm" onClick={() => navigate('/balances')}>Open Outstanding Balances</button>
          )}
        </div>
        {creditModal}
      </div>
    )
  }

  // "Change property" — offered when there is another to pick (or the one asked
  // for could not be shown).
  const canChange = properties.length > 1 || (!!picked && picked !== propertyToShow(null, propsQ.data))
  const changeButton = canChange && (
    <button className="btn btn-ghost btn-sm" onClick={() => pick(null)}>Change property</button>
  )
  const colCount = canTake ? 8 : 7

  let body: JSX.Element
  if (propsQ.isLoading) {
    body = <div className="card cd-empty">Loading…</div>
  } else if (propsQ.error) {
    body = (
      <div className="card cd-empty">
        <p className="cd-msg">{serverMessage(propsQ.error, 'The properties could not be read.')}</p>
        <button className="btn btn-primary btn-sm" disabled={propsQ.isFetching} onClick={() => propsQ.refetch()}>
          {propsQ.isFetching ? 'Reading…' : 'Read them again'}
        </button>
      </div>
    )
  } else if (!propertyId) {
    // 10/13 (Nic): "you select either property and view only those properties."
    body = properties.length === 0 ? (
      <div className="card cd-empty">No properties yet.</div>
    ) : (
      <div className="card pay-pick">
        <div className="pay-pick-head">Which property?</div>
        {properties.map(p => (
          <button key={p.propertyId} type="button" className="pay-prop" onClick={() => pick(p.propertyId)}>
            <span className="pay-prop-name">{p.name}</span>
            <span className="pay-prop-meta">{p.spaces} {p.spaces === 1 ? 'space' : 'spaces'}</span>
            <ChevronRight size={15} />
          </button>
        ))}
      </div>
    )
  } else if (rollQ.isLoading || (!roll && !rollQ.error)) {
    body = <div className="card cd-empty">Loading…</div>
  } else if (!roll) {
    body = (
      <div className="card cd-empty">
        <p className="cd-msg">{serverMessage(rollQ.error, 'This month could not be read.')}</p>
        <div className="cd-actions" style={{ justifyContent: 'center' }}>
          {![400, 404].includes(serverStatus(rollQ.error) ?? 0) && (
            <button className="btn btn-primary btn-sm" disabled={rollQ.isFetching} onClick={() => rollQ.refetch()}>
              {rollQ.isFetching ? 'Reading…' : 'Read it again'}
            </button>
          )}
          {changeButton}
        </div>
      </div>
    )
  } else {
    const t = roll.totals
    body = (
      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        <div className="pay-head">
          <h2 className="pay-title">{roll.propertyName} · {monthTitle(roll.month)}</h2>
          {changeButton}
          {/* decisions #25: a sum across households only when the server sent it. */}
          {t && (
            <div className="cd-totals">
              <span>Invoiced <strong>{money(t.invoiced)}</strong></span>
              <span>Paid <strong>{money(t.paid)}</strong></span>
              {toCents(t.workTrade) > 0 && <span>Work trade <strong>{money(t.workTrade)}</strong></span>}
              <span>Owed <strong>{money(t.owed)}</strong></span>
              {toCents(t.owedEarlier) > 0 && <span>Owed from earlier months <strong>{money(t.owedEarlier)}</strong></span>}
            </div>
          )}
        </div>
        {roll.rows.length === 0 ? (
          <div className="cd-empty">No spaces at this property yet.</div>
        ) : (
          <table className="data-table pay-table" style={{ minWidth: 860 }}>
            <thead>
              <tr>
                <th>Space</th><th>Tenant</th>
                <th className="num">Invoiced</th><th className="num">Paid</th><th className="num">Owed</th>
                <th>Payment method</th><th>Status</th>
                {canTake && <th aria-label="Record payment"></th>}
              </tr>
            </thead>
            <tbody>
              {/* The server's order: still owing first, then space order (10/13). */}
              {roll.rows.map(r => {
                // A space nobody holds on a lease (Vacant, or in use): no money, nothing to open.
                const vacant = isSpaceOnlyRow(r)
                const open = !vacant && openKeys.has(r.key)
                const report = reportPath(r)
                const paid = paidWords(r)
                const earlier = earlierWords(r)
                return (
                  <Fragment key={r.key}>
                    <tr className={`pay-row${vacant ? '' : ' pay-click'}${open ? ' pay-open' : ''}`} data-key={r.key}
                      onClick={vacant ? undefined : () => toggle(r.key)}
                      tabIndex={vacant ? undefined : 0} aria-expanded={vacant ? undefined : open}
                      onKeyDown={vacant ? undefined : e => {
                        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(r.key) }
                      }}
                      title={vacant ? undefined : open ? 'Hide the payments and charges' : 'Show the payments and charges'}>
                      <td className="pay-space">
                        {!vacant && <span className="pay-caret">{open ? '▾' : '▸'}</span>}
                        {r.space ?? '—'}
                      </td>
                      <td>
                        {vacant ? (r.occupant ?? <span className="pay-muted">—</span>) : report ? (
                          <button type="button" className="pay-name" title="Open their payment report"
                            onClick={e => { e.stopPropagation(); navigate(report) }}>
                            {householdName(r)}
                          </button>
                        ) : householdName(r)}
                        {r.movedOut && <div><span className="pay-tag">Moved out</span></div>}
                        {/* 10/13 (Nic): "we have eviction mode that blocks payments". */}
                        {r.evictionMode && <div><span className="pay-tag evict">Eviction mode — payments blocked</span></div>}
                      </td>
                      <td className="num mono">
                        {vacant ? null : toCents(r.invoiced) > 0 ? money(r.invoiced) : <span className="pay-muted">—</span>}
                      </td>
                      <td className="num mono">
                        {vacant ? null : (
                          <>
                            {paid.amount ?? <span className="pay-muted">—</span>}
                            {/* As on the Rent Roll: work trade's value beside Paid. */}
                            {paid.workTrade && <span className="pay-sub">{paid.workTrade}</span>}
                            {toCents(r.clearing) > 0 && <span className="pay-sub">{money(r.clearing)} still clearing</span>}
                          </>
                        )}
                      </td>
                      <td className="num mono">
                        {vacant ? null : (
                          <>
                            {toCents(r.owed) > 0 ? <span className="pay-owed">{money(r.owed)}</span> : <span className="pay-muted">—</span>}
                            {/* 10/13 (Nic): "outstanding balances are always at the top" — earlier months too. */}
                            {earlier && <span className="pay-sub pay-earlier">{earlier}</span>}
                          </>
                        )}
                      </td>
                      <td>{vacant ? null : r.methods.length > 0 ? r.methods.join(', ') : <span className="pay-muted">—</span>}</td>
                      <td><span className={`pay-pill ${r.statusColor}`}>{r.statusLabel}</span></td>
                      {canTake && (
                        <td className="pay-record">
                          {rowTakesPayment(r, canTake) && (
                            <button className="btn btn-primary btn-sm" onClick={e => { e.stopPropagation(); openRecord(r) }}>
                              Record payment
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                    {open && (
                      <tr className="pay-detail">
                        <td colSpan={colCount}><OpenMonthDetail row={r} month={roll.month} canAddPhoto={canTake} /></td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    )
  }

  return (
    <div>
      {header}
      {noticeBar}
      {body}

      {recording && (
        <RecordPaymentWindow anchorPaymentId={recording.anchorId} tenantId={recording.tenantId} name={recording.name}
          onClose={() => {
            setRecording(null)
            if (recorded.current) { setNotice(recorded.current); recorded.current = null }
            refresh()
          }}
          onRecorded={(m) => { recorded.current = m }} />
      )}
      {picking && roll && (
        <RecordPaymentPicker rows={roll.rows}
          onClose={() => setPicking(false)}
          onRecord={(r) => { setPicking(false); openRecord(r) }}
          onAhead={(r) => { setPicking(false); openAhead(r) }} />
      )}
      {posting && (
        <PostPaymentForm tenantId={posting.tenantId} name={posting.name}
          onClose={() => setPosting(null)}
          onChangePerson={() => { setPosting(null); setPicking(true) }}
          onPosted={(m) => { setPosting(null); setNotice(m); refresh() }} />
      )}
      {creditModal}
    </div>
  )
}
