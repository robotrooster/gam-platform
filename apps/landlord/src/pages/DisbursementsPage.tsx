import { useState } from 'react'
import { useQuery } from 'react-query'
import { Link } from 'react-router-dom'
import { humanize , DISBURSEMENT_TRIGGER_LABEL } from '@gam/shared'
import { apiGet } from '../lib/api'
import { useEntities } from '../components/EntityPicker'
import { usePerms } from '../lib/permissions'
import { X } from 'lucide-react'
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

// S607 (Nic): "If the landlord is covering the ten dollars, it needs to be
// visible to them so they can track it. If the landlord is not covering the ten
// dollars, it doesn't need to be visible to them."
//
// So this renders NOTHING at all when the tenant is the one reimbursing the fee
// — there is nothing for the landlord to track, and an empty card claiming a
// cost they do not bear is noise. It appears only once they have actually
// absorbed something, which is also the moment the payout reduction becomes
// real: ten cash payments is $100 off a disbursement, and it should have a name.
function AbsorbedManualFeesSection({ companyId }: { companyId: string }) {
  const { data } = useQuery<any>('absorbed-manual-fees',
    () => apiGet('/payments/absorbed-manual-fees?months=6'))
  const rows: any[] = (data?.rows ?? []).filter((r: any) => !companyId || r.landlordId === companyId)
  const total = rows.reduce((n: number, r: any) => n + Number(r.amount || 0), 0)
  if (!rows.length) return null

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <h3 style={{ margin: 0, fontSize: '1rem' }}>Cash-payment fees you're covering</h3>
        <span style={{ fontWeight: 700 }}>{fmt(total)}</span>
      </div>
      <div style={{ fontSize: '.78rem', color: 'var(--text-2)', lineHeight: 1.55, marginBottom: 10 }}>
        You've chosen to cover the fee on cash, check and money-order payments, so it comes out of
        your payout instead of being billed to the tenant. {rows.length} payment{rows.length === 1 ? '' : 's'} in
        the last 6 months. Each tenant's first payment is always free. You can switch this back to
        the tenant on the property's fee settings at any time.
      </div>
      <div style={{ maxHeight: 220, overflowY: 'auto' }}>
        {rows.map((r: any) => (
          <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10,
                                   padding: '6px 0', borderBottom: '1px solid var(--border-0)', fontSize: '.8rem' }}>
            <span style={{ color: 'var(--text-2)' }}>
              {r.propertyName}{r.unitNumber ? ` · ${r.unitNumber}` : ''}
            </span>
            <span style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
              <span style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
                {new Date(r.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
              <span className="mono">{fmt(r.amount)}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}


// ── S651: what you pay GAM ────────────────────────────────────────────────
//
// This sat in the database and on no screen. GAM netted $130 of platform fees
// out of Mountain View's next payout and the landlord saw a deposit short by
// $130 with nothing, anywhere, saying why. Nic's worry about landlords
// disputing a charge starts here, one step before any bank debit: a number you
// cannot see is a number you can only argue with.
//
// It lives on Disbursements rather than its own page because this is the screen
// somebody opens when a payout looks wrong — the explanation belongs where the
// question gets asked.

const GAM_CHARGE_LABEL: Record<string, string> = {
  subscription:       'Platform fee',
  manual_payment_fee: 'Fee on a payment taken outside GAM',
  // S651: shown as its own line on purpose — see services/landlordGamDebit.ts.
  bank_debit_cost:    'Bank transfer cost',
}

function GamChargesSection({ companyId }: { companyId: string }) {
  const { data } = useQuery<any>('gam-charges', () => apiGet('/landlords/me/gam-charges'))

  // S652 (Nic): "it blends both properties on the What you pay GAM card" —
  // the page's company filter cuts this card too, and the total is the sum of
  // what is shown, never the account-wide figure under a company heading.
  const mine = (r: any) => !companyId || r.landlordId === companyId
  const charges: any[] = (data?.charges ?? []).filter(mine)
  const debits: any[] = (data?.debits ?? []).filter(mine)
  const banks: any[] = (data?.banks ?? []).filter(mine)
  if (!charges.length && !debits.length) return null

  const outstanding = Math.round(charges.reduce(
    (n: number, c: any) => n + (Number(c.amount) - Number(c.collectedAmount)), 0) * 100) / 100
  const missingBank = banks.filter((b: any) => !b.hasBankLink)

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <h3 style={{ margin: 0, fontSize: '1rem' }}>What you pay GAM</h3>
        <span style={{ fontWeight: 700 }}>{outstanding > 0 ? fmt(outstanding) : 'Nothing owed'}</span>
      </div>
      <div style={{ fontSize: '.78rem', color: 'var(--text-2)', lineHeight: 1.55, marginBottom: 10 }}>
        These come out of money already on its way to you, so they cost you no extra transfer —
        which is why a payout can land smaller than the rent collected. The difference is itemised
        below. If a property takes only cash there’s no payout to take them from, and once the
        balance passes {fmt(banks[0]?.threshold ?? 100)} they’re transferred from your linked bank
        instead{banks[0]?.gamDebitBankLast4 ? ` (ending ${banks[0].gamDebitBankLast4})` : ''},
        plus {fmt(data?.bankTransferCost ?? 6)} for the transfer, shown as its own line so you can
        check both numbers.
      </div>

      {missingBank.length > 0 && (
        // Not a way out of the bill — a thing that will stop working. Said
        // plainly and early, because the alternative is a landlord finding out
        // when collection fails.
        <div style={{ fontSize: '.78rem', color: 'var(--amber)', lineHeight: 1.55, marginBottom: 10 }}>
          {missingBank.map((b: any) => b.businessName || 'Your company').join(', ')} has no bank
          linked. These charges still stand — link a bank so they can be settled without anyone
          chasing it. <Link to="/bank">Link a bank</Link>
        </div>
      )}

      <div style={{ maxHeight: 260, overflowY: 'auto', marginBottom: debits.length ? 12 : 0 }}>
        {charges.map((c: any) => {
          const amount = Number(c.amount)
          const collected = Number(c.collectedAmount)
          const paid = collected >= amount
          return (
            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10,
                                     padding: '6px 0', borderBottom: '1px solid var(--border-0)', fontSize: '.8rem' }}>
              <span style={{ color: 'var(--text-2)' }}>
                {GAM_CHARGE_LABEL[c.kind] ?? humanize(c.kind)}
                {c.propertyName ? ` · ${c.propertyName}` : ''}
                {c.notes ? <span style={{ color: 'var(--text-3)' }}> — {c.notes}</span> : null}
              </span>
              <span style={{ display: 'flex', gap: 12, alignItems: 'baseline', whiteSpace: 'nowrap' }}>
                <span style={{ fontSize: '.72rem', color: paid ? 'var(--text-3)' : 'var(--amber)' }}>
                  {paid
                    ? `taken from your payout ${new Date(c.collectedAt ?? c.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                    : collected > 0 ? `${fmt(collected)} of it taken so far` : 'comes out of your next payout'}
                </span>
                <span className="mono">{fmt(amount)}</span>
              </span>
            </div>
          )
        })}
      </div>

      {debits.length > 0 && (
        <div>
          <div style={{ fontSize: '.78rem', fontWeight: 600, marginBottom: 4 }}>Taken from your bank</div>
          {debits.map((d: any) => (
            <div key={d.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10,
                                     padding: '6px 0', borderBottom: '1px solid var(--border-0)', fontSize: '.8rem' }}>
              <span style={{ color: 'var(--text-2)' }}>
                {new Date(d.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                {' · '}charges {fmt(d.chargesAmount)} + bank transfer cost {fmt(d.bankCostAmount)}
                {d.status === 'failed' && d.failureReason ? ` — your bank declined it: ${d.failureReason}` : ''}
              </span>
              <span className="mono">{fmt(d.totalAmount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function DisbursementsPage() {
  const { data: disbs = [], isLoading } = useQuery<any[]>('disbursements', () => apiGet('/disbursements'))

  // S637 (Nic, DIRECTIVE): "disbursements page needs to show first to who and
  // where", and every multi-property view needs a filter. A payout carries no
  // property — one weekly payout aggregates whatever came in across that
  // COMPANY's parks — so the company is the grain that exists.
  //
  // S652 (Nic): "I want to see all of Oak Park's disbursements, total disbursed
  // and total pending ... it blends both properties on the What you pay GAM
  // card." One filter at the top of the page, listing every company on the
  // account (not just the ones that happen to have a payout row), and EVERY
  // card below it follows: next payout, covered cash fees, what you pay GAM,
  // the two totals and the list. Nothing on this page is account-wide while a
  // company is chosen.
  const [companyId, setCompanyId] = useState('')
  const { data: entities = [] } = useEntities()
  const shown = (disbs as any[]).filter(d => companyId === '' || d.landlordId === companyId)
  const [selected, setSelected] = useState<any | null>(null)
  const { can } = usePerms()

  // A payout Stripe is still moving is money on its way, not money missing.
  const isPending = (d: any) => d.status === 'pending' || d.status === 'processing'
  const totalSettled = shown.filter((d: any) => d.status === 'settled').reduce((sum: number, d: any) => sum + Number(d.amount), 0)
  const totalPending = shown.filter(isPending).reduce((sum: number, d: any) => sum + Number(d.amount), 0)

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Disbursements</h1>
          <p className="page-subtitle">Your collected balance pays out automatically to your linked bank account</p>
        </div>
      </div>

      {entities.length > 1 && (
        <div className="filter-bar" style={{ marginBottom: 16 }}>
          <select className="form-input" style={{ width: 'auto', minWidth: 220 }}
                  value={companyId} onChange={e => setCompanyId(e.target.value)}>
            <option value="">All companies</option>
            {entities.map((en: any) => (
              <option key={en.id} value={en.id}>
                {en.businessName || 'Unnamed company'}
                {en.propertyCount ? ` — ${en.propertyCount} propert${en.propertyCount === 1 ? 'y' : 'ies'}` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      <NextPayoutFlow companyId={companyId} />
      <BalanceWithdrawSection />

      {can('disbursements.pm_impact_view') && <PmImpactSection />}

      <AbsorbedManualFeesSection companyId={companyId} />

      <GamChargesSection companyId={companyId} />

      <div className="kpi-grid" style={{ marginBottom: 24 }}>
        <div className="kpi-card">
          <div className="kpi-label">Total Disbursed</div>
          <div className="kpi-value green">{fmt(totalSettled)}</div>
          <div className="kpi-sub">{shown.filter((d: any) => d.status === 'settled').length} settled payouts</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Pending</div>
          <div className="kpi-value amber">{fmt(totalPending)}</div>
          <div className="kpi-sub">{shown.filter(isPending).length} on the way</div>
        </div>
      </div>

      <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
        {isLoading ? (
          <div style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading...</div>
        ) : (
          <>
            <table className="data-table" style={{ minWidth: 820 }}>
              <thead><tr>
                <th>Date</th><th>To</th><th>Company</th><th>Type</th><th>Amount</th><th>Fee</th><th>Bank</th><th>Status</th><th>Settled</th>
              </tr></thead>
              <tbody>
                {shown.length ? shown.map((d: any) => (
                  <tr key={d.id} onClick={() => setSelected(d)} style={{ cursor: 'pointer' }}>
                    <td className="mono">{new Date(d.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                    {/* S637: WHO the money went to — selected by the API all
                        along and never rendered. */}
                    <td style={{ fontSize: '.8rem' }}>
                      {[d.firstName, d.lastName].filter(Boolean).join(' ') || '—'}
                      {d.email && <div style={{ fontSize: '.68rem', color: 'var(--text-3)' }}>{d.email}</div>}
                    </td>
                    <td style={{ fontSize: '.78rem', color: 'var(--text-2)' }}>{d.companyName || d.companiesOnAccount || '—'}</td>
                    <td style={{ fontSize: '.78rem' }}>
                      {DISBURSEMENT_TRIGGER_LABEL[d.triggerType] ?? (d.triggerType ? humanize(d.triggerType) : '—')}
                    </td>
                    <td className="mono" style={{ color: 'var(--green)', fontWeight: 700 }}>{fmt(d.amount)}</td>
                    <td className="mono" style={{ fontSize: '.78rem', color: parseFloat(d.feeCharged ?? '0') > 0 ? 'var(--red)' : 'var(--text-3)' }}>
                      {parseFloat(d.feeCharged ?? '0') > 0 ? `−${fmt(d.feeCharged)}` : '—'}
                    </td>
                    <td style={{ fontSize: '.78rem' }}>
                      {d.bankNickname || d.bankName
                        ? <>{d.bankNickname || d.bankName} <span style={{ color: 'var(--text-3)' }}>•••• {d.bankLast4}</span></>
                        : <span style={{ color: 'var(--text-3)' }}>—</span>}
                    </td>
                    <td>
                      <span className={'badge ' + (d.status === 'settled' ? 'badge-green' : isPending(d) ? 'badge-amber' : 'badge-red')}>
                        {d.status === 'settled' ? 'Settled' : d.status === 'processing' ? 'On its way' : d.status === 'pending' ? 'Pending' : humanize(d.status)}
                      </span>
                    </td>
                    <td className="mono" style={{ fontSize: '.75rem', color: 'var(--text-3)' }}>
                      {d.settledAt ? new Date(d.settledAt).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                )) : (
                  <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text-3)', padding: 40 }}>
                    {(disbs as any[]).length
                      ? 'No disbursements for this company.'
                      : 'No disbursements yet. Auto-Friday payouts begin once a property is routed to a bank account and rent has been collected.'}
                  </td></tr>
                )}
              </tbody>
            </table>
            <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border-0)', fontSize: '.75rem', color: 'var(--text-3)' }}>
              Click any row for full disbursement detail
            </div>
          </>
        )}
      </div>

      {selected && (
        <div className="modal-overlay" onClick={() => setSelected(null)}>
          <div className="modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
              <div className="modal-title" style={{ marginBottom: 0 }}>Disbursement Detail</div>
              <button className="btn btn-ghost btn-sm" onClick={() => setSelected(null)} style={{ padding: 6 }}><X size={15} /></button>
            </div>
            <div style={{ background: 'var(--bg-3)', borderRadius: 10, padding: 16, marginBottom: 16, textAlign: 'center' }}>
              <div style={{ fontSize: '.75rem', color: 'var(--text-3)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.06em' }}>Amount Disbursed</div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: '2rem', fontWeight: 800, color: 'var(--green)' }}>{fmt(selected.amount)}</div>
              <div style={{ fontSize: '.8rem', color: 'var(--text-3)', marginTop: 4 }}>
                {new Date(selected.createdAt).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
              </div>
            </div>
            <div className="data-row"><span className="data-key">Status</span>
              <span className={'badge ' + (selected.status === 'settled' ? 'badge-green' : 'badge-amber')}>{humanize(selected.status)}</span>
            </div>
            <div className="data-row"><span className="data-key">Trigger</span>
              <span className="data-val">{DISBURSEMENT_TRIGGER_LABEL[selected.triggerType] ?? (selected.triggerType ? humanize(selected.triggerType) : '—')}</span>
            </div>
            {selected.bankNickname && (
              <div className="data-row"><span className="data-key">Destination bank</span>
                <span className="data-val">{selected.bankNickname} •••• {selected.bankLast4}</span>
              </div>
            )}
            {parseFloat(selected.feeCharged ?? '0') > 0 && (
              <div className="data-row"><span className="data-key">Fee</span><span className="data-val mono" style={{ color: 'var(--red)' }}>−{fmt(selected.feeCharged)}</span></div>
            )}
            <div className="data-row"><span className="data-key">Initiated</span><span className="data-val mono" style={{ fontSize: '.8rem' }}>{selected.initiatedAt ? new Date(selected.initiatedAt).toLocaleString() : '—'}</span></div>
            <div className="data-row"><span className="data-key">Settled</span><span className="data-val mono" style={{ fontSize: '.8rem' }}>{selected.settledAt ? new Date(selected.settledAt).toLocaleString() : 'Pending'}</span></div>
          </div>
        </div>
      )}
    </div>
  )
}

// S650 (Nic): "Clicking the tile gives no details ... collected / held for
// payout / held until your bank is linked / available now / link your bank as
// disconnected pieces. It needs to read as one continuous flow and show what
// the $495 is made of."
//
// One card, left to right: still clearing at the tenant's bank → cleared and
// held for you → sent to your bank on the next run. Below it, every payment in
// the next payout, so the number is never a mystery.
const TYPE_LABEL: Record<string, string> = { rent: 'Rent', utility: 'Utilities', deposit: 'Deposit', fee: 'Fee', late_fee: 'Late fee' }
function NextPayoutFlow({ companyId }: { companyId: string }) {
  const { data, isLoading } = useQuery<any>('next-payout', () => apiGet('/landlords/me/next-payout'))
  const [showClearing, setShowClearing] = useState(false)
  if (isLoading || !data) return null
  // One company at a time when the page is filtered: its payments, its total.
  const cut = (g: any, k: string) => {
    const rows = (g?.rows ?? []).filter((r: any) => !companyId || r.landlordId === companyId)
    return { rows, total: Math.round(rows.reduce((n: number, r: any) => n + Number(r[k] || 0), 0) * 100) / 100 }
  }
  const ready = cut(data.ready, 'toYou')
  const clearing = cut(data.clearing, 'paid')
  const when = data.nextPayoutDate
    ? new Date(data.nextPayoutDate).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
    : 'the next weekly run'
  const step = (label: string, amount: number, sub: React.ReactNode, tone: string, active: boolean) => (
    <div style={{ flex: '1 1 180px', padding: '14px 16px', borderRadius: 10, background: active ? 'var(--bg-3)' : 'transparent',
                  border: '1px solid var(--border-1)', opacity: active ? 1 : .6 }}>
      <div style={{ fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-3)' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', fontWeight: 800, color: tone, margin: '4px 0' }}>{fmt(amount)}</div>
      <div style={{ fontSize: '.76rem', color: 'var(--text-2)', lineHeight: 1.45 }}>{sub}</div>
    </div>
  )
  const arrow = <div style={{ alignSelf: 'center', color: 'var(--text-3)', fontSize: '1.2rem' }}>→</div>
  const row = (r: any) => (
    <tr key={r.id}>
      <td className="mono" style={{ fontSize: '.78rem' }}>{new Date(r.dated).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
      <td>{r.kind === 'held' ? (r.description || 'Register sale') : (r.tenantName || '—')}</td>
      <td style={{ fontSize: '.78rem', color: 'var(--text-2)' }}>{r.kind === 'held' ? '' : [r.propertyName, r.unitNumber].filter(Boolean).join(' · ')}</td>
      <td style={{ fontSize: '.78rem' }}>{r.kind === 'held' ? 'Card sale' : (TYPE_LABEL[r.type] || humanize(r.type || ''))}</td>
      <td className="mono" style={{ textAlign: 'right' }}>{fmt(r.paid)}</td>
      <td className="mono" style={{ textAlign: 'right', fontWeight: 700, color: 'var(--green)' }}>{fmt(r.kind === 'held' ? r.toYou : (r.status === 'processing' ? r.paid : r.toYou))}</td>
    </tr>
  )
  return (
    <div className="card" id="next-payout" style={{ marginBottom: 24 }}>
      <div className="card-header"><span className="card-title">Your next payout</span></div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
        {step('Clearing at tenants\' banks', clearing.total,
          clearing.rows.length ? `${clearing.rows.length} payment${clearing.rows.length === 1 ? '' : 's'} — bank payments take a few days to clear` : 'Nothing clearing right now',
          'var(--amber)', clearing.rows.length > 0)}
        {arrow}
        {step('Cleared — held for you', ready.total,
          ready.rows.length ? `${ready.rows.length} payment${ready.rows.length === 1 ? '' : 's'}, listed below` : 'Nothing waiting yet',
          'var(--gold)', ready.rows.length > 0)}
        {arrow}
        {step(data.bankLinked ? `Sent to your bank ${when}` : 'Waiting for your bank', ready.total,
          data.bankLinked
            ? 'Paid out automatically on the weekly run'
            : <>Link your bank at <Link to="/banking" style={{ color: 'var(--gold)' }}>Banking</Link> and it goes out on the next run</>,
          'var(--green)', ready.rows.length > 0)}
      </div>
      {ready.rows.length > 0 && (
        <table className="data-table" style={{ marginTop: 16 }}>
          <thead><tr><th>Date</th><th>From</th><th>Where</th><th>For</th><th style={{ textAlign: 'right' }}>Paid</th><th style={{ textAlign: 'right' }}>To you</th></tr></thead>
          <tbody>{ready.rows.map(row)}</tbody>
          <tfoot><tr><td colSpan={5} style={{ textAlign: 'right', fontWeight: 600 }}>Next payout</td><td className="mono" style={{ textAlign: 'right', fontWeight: 800, color: 'var(--green)' }}>{fmt(ready.total)}</td></tr></tfoot>
        </table>
      )}
      {clearing.rows.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <button className="btn btn-ghost btn-sm" onClick={() => setShowClearing(v => !v)}>{showClearing ? 'Hide' : 'Show'} what is still clearing</button>
          {showClearing && (
            <table className="data-table" style={{ marginTop: 8 }}>
              <thead><tr><th>Date</th><th>From</th><th>Where</th><th>For</th><th style={{ textAlign: 'right' }}>Paid</th><th style={{ textAlign: 'right' }}>Clearing</th></tr></thead>
              <tbody>{clearing.rows.map(row)}</tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}

// S574 (Nic): on-demand withdrawal retired — the platform holds the balance and
// pays it out on the automatic Friday batch, so this is a read-only balance
// summary now (no "Withdraw Now" flow, no payout banner).
function BalanceWithdrawSection() {
  const { data, isLoading } = useQuery<any>('me-finances-summary', () => apiGet('/users/me/finances?limit=1'))
  if (isLoading || !data) return null
  if (!(Number(data.currentBalance ?? 0) > 0) && !(Number(data.pendingBalance ?? 0) > 0)) return null

  const balance = Number(data.currentBalance ?? 0)
  const pending = Number(data.pendingBalance ?? 0)

  return (
    <div style={{ marginBottom: 24 }}>
      <div className="kpi-grid">
        {/* S650: only when something is actually sitting there — under
            platform holds this is $0 by design, and the flow above says where
            the money is. */}
        {balance > 0 && (
          <div className="kpi-card">
            <div className="kpi-label">In your payout account</div>
            <div className="kpi-value gold">{fmt(balance)}</div>
            <div className="kpi-sub">Goes to your bank automatically</div>
          </div>
        )}
        {pending > 0 && (
          <div className="kpi-card">
            <div className="kpi-label">Pending Settlement</div>
            <div className="kpi-value amber">{fmt(pending)}</div>
            <div className="kpi-sub">In flight — clears in 1–3 days</div>
          </div>
        )}
      </div>

    </div>
  )
}

// S159: per-property PM impact for the current month. Renders only when
// at least one property has a non-zero PM cut. Mirrors the dashboard
// tile but with per-property breakdown — gross / pm_fee / your net.
function PmImpactSection() {
  const monthStart = (() => { const d = new Date(); d.setDate(1); return d.toISOString().slice(0,10) })()
  const today = new Date().toISOString().slice(0,10)

  const { data } = useQuery<{ rows: Array<{
    propertyId: string; propertyName: string;
    pmCompanyId: string | null; pmCompanyName: string | null;
    pmFeePlanName: string | null;
    pmCompanyCut: string; ownerNet: string; inHouseManagerFee: string;
    totalSplit: string;
  }> }>(
    ['pm-impact-mtd-table', monthStart, today],
    () => apiGet(`/landlords/me/pm-impact?from=${monthStart}&to=${today}`),
    { staleTime: 5 * 60 * 1000 },
  )

  const rows = (data?.rows ?? []).filter(r => r.pmCompanyId)
  if (rows.length === 0) return null

  const totalGross = rows.reduce((s, r) => s + Number(r.totalSplit), 0)
  const totalPmFee = rows.reduce((s, r) => s + Number(r.pmCompanyCut), 0)
  const totalNet   = rows.reduce((s, r) => s + Number(r.ownerNet), 0)

  return (
    <div className="card" style={{ marginBottom: 24, padding: 0, overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border-0)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>PM Impact — month-to-date</div>
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
          Gross {fmt(totalGross)} · PM Fee {fmt(totalPmFee)} · Net {fmt(totalNet)}
        </div>
      </div>
      <table className="data-table" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th>Property</th><th>PM Company</th><th>Fee Plan</th>
            <th style={{ textAlign: 'right' }}>Gross</th>
            <th style={{ textAlign: 'right' }}>PM Fee</th>
            <th style={{ textAlign: 'right' }}>Your Net</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.propertyId}>
              <td><strong>{r.propertyName}</strong></td>
              <td>{r.pmCompanyName ?? '—'}</td>
              <td style={{ color: 'var(--text-3)', fontSize: '.78rem' }}>{r.pmFeePlanName ?? '—'}</td>
              <td style={{ textAlign: 'right' }}>{fmt(r.totalSplit)}</td>
              <td style={{ textAlign: 'right', color: 'var(--gold)' }}>{fmt(r.pmCompanyCut)}</td>
              <td style={{ textAlign: 'right', color: 'var(--green, #2ea35a)' }}>{fmt(r.ownerNet)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
