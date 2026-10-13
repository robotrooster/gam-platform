import { useState } from 'react'
import { useQuery } from 'react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Printer } from 'lucide-react'
import { PAYMENT_STAMP_LABEL } from '@gam/shared'
import { api } from '../lib/api'
import { money, monthTitle, dayWord, monthWord } from '../lib/creditDesk'
import { stampText, stampTitle, shortMonth, stripYear, healthColor, lineLateness, type StampMonth, type HealthFigure, type ChargeLine } from '../lib/paymentStamps'
import '../styles/rent-roll.css'

/**
 * THE TENANT PAYMENT REPORT (10/12, Nic) — /tenants/:id/report, printable.
 *
 *   "household-wide; summary (payment health %, months on time / late /
 *    partial / outstanding over the window); HOW LATE: each late month's days
 *    past grace, plus the pattern (median and range, e.g. 'usually 1-2 days
 *    past grace'); PARTIALS: count, average partial amount, average days to
 *    settle the rest; full charge history with a 'What it's for' column (Rent,
 *    Electric, Late fee, Home payment, ...) for every line, paid date, method,
 *    amount; credits applied; work trade covered."
 *
 * Every figure is the server's (GET /api/tenants/:id/payment-report — the one
 * payment-health definition). Days late are always days past the grace
 * period. On a phone the history scrolls inside its own box. 10/12 (Nic): the
 * report covers ALL TIME (since the household joined GAM), not 12 months — the
 * health, the month counts and the stamps (newest first, like the Rent Roll).
 * 10/12 (Nic): "CSV-imported old payment history does NOT count toward payment
 * health — health starts with the first bill GAM wrote; imported history still
 * shows in the report." It is its own section at the end, each line labeled
 * with where it came from.
 */

interface ReportLease {
  leaseId: string; propertyName: string; unitNumber: string; status: string; leaseTypeLabel: string
  startDate: string; endDate: string | null; rentAmount: number; rentDueDay: number
  graceDays: number; graceSourceLabel: string; firstLateDayText: string; lateFeeTerms: string; existingTenancy: boolean
  delinquent: boolean; evictionMode: boolean
}
interface HistoryLine extends ChargeLine { lateFeeCount?: number; lateFeeFrom?: string; lateFeeTo?: string; lateFees?: ChargeLine[] }
/** A payment brought in from another platform's history (never counted). */
interface ImportedLine {
  paymentId: string; paidOn: string; label: string; unitNumber: string | null; amount: number
  importedFrom: string; method: string | null; reference: string | null
}
interface Report {
  householdId: string
  members: Array<{ tenantId: string; name: string; role: string | null }>
  name: string
  leases: ReportLease[]
  onGamSince: string | null
  onboardingMonth: string | null
  balanceOwedNow: number
  health: HealthFigure
  stamps: Array<StampMonth & { counted: boolean }>
  howLate: {
    months: Array<{ month: string; daysPastGrace: number; paidInFullOn: string | null; stillOpen: boolean; firstLateDay: string | null }>
    pattern: string | null; median: number | null; min: number | null; max: number | null; average: number | null
    distribution: Array<{ bucket: string; label: string; months: number }>
    worst: { month: string; daysPastGrace: number } | null
    trend: { recent: number | null; earlier: number | null } | null
  }
  partials: {
    months: number; averageFirstPayment: number | null; averageFirstPercent: number | null; averageDaysToSettle: number | null
    open: Array<{ month: string; owed: number; daysSinceFirstPayment: number | null }>
  }
  lateFees: { charged: number; paid: number; credit: number; owed: number; months: number }
  creditApplied: number
  workTrade: {
    monthsCovered: number; valueCovered: number
    byCharge: Array<{ label: string; amount: number }>
    agreements: Array<{ status: string; coveredCharges: string[]; tracksHours: boolean; monthlyHoursTarget: number }>
    hours: Array<{ month: string; worked: number; target: number }>
  }
  history: HistoryLine[]
  imported?: ImportedLine[]
}

const KV = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="tr-kv"><span className="tr-k">{k}</span><span className="tr-v">{v}</span></div>
)

export function TenantPaymentReportPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [openFees, setOpenFees] = useState<Set<string>>(() => new Set())
  const { data: r, isLoading, error, refetch, isFetching } = useQuery(['tenant-payment-report', id],
    () => api.get(`/tenants/${id}/payment-report`).then(x => x.data.data as Report), {
      enabled: !!id,
      // A refusal or a resident with no history here will not change on a retry: say it once.
      retry: (count: number, e: any) => { const st = e?.response?.status; return !(st >= 400 && st < 500) && count < 2 },
    })

  if (isLoading) return <div className="card" style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
  if (error || !r) {
    const status = (error as any)?.response?.status
    const refused = status >= 400 && status < 500
    // 10/12: a refusal is said in words the viewer can act on — the server's
    // 403 text ("Insufficient permissions", "Forbidden") is not; a 404 keeps
    // the server's sentence (no history at the properties you can see).
    const msg = status === 403
      ? 'The payment report needs the “View all payments” permission — ask the owner if you need it.'
      : ((error as any)?.response?.data?.error ?? 'The payment report could not be read.')
    return (
      <div className="card" style={{ padding: 24, textAlign: 'center' }}>
        <p style={{ color: 'var(--text-2)', marginBottom: 10 }}>{msg}</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          {!refused && <button className="btn btn-primary btn-sm" disabled={isFetching} onClick={() => refetch()}>{isFetching ? 'Reading…' : 'Read it again'}</button>}
          <button className="btn btn-ghost btn-sm" onClick={() => navigate(-1)}>Back</button>
        </div>
      </div>
    )
  }

  const h = r.health
  const maxBucket = Math.max(1, ...r.howLate.distribution.map(d => d.months))
  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button className="btn btn-ghost btn-sm rr-noprint" aria-label="Back" onClick={() => navigate(-1)}><ArrowLeft size={15} /></button>
          <div>
            <h1 className="page-title" style={{ marginBottom: 2 }}>Payment report — {r.name}</h1>
            <p className="page-subtitle">
              {r.members.length > 1 ? `Household: ${r.members.map(m => m.name).join(', ')} · ` : ''}
              {r.onGamSince ? `On GAM since ${monthTitle(r.onGamSince)}` : 'No bills yet'}
              {r.onboardingMonth ? ` · onboarding month ${monthWord(r.onboardingMonth)}` : ''}
            </p>
          </div>
        </div>
        <button className="btn btn-primary btn-sm rr-noprint" onClick={() => window.print()}><Printer size={13} /> Print</button>
      </div>

      <div className="tr-grid">
        <div className="card">
          <div className="card-title" style={{ marginBottom: 10 }}>Pays on time</div>
          <div className="tr-health">
            <span className="tr-health-pct" style={{ color: healthColor(h.percent) }}>{h.percent === null ? '—' : `${h.percent}%`}</span>
            <span style={{ fontSize: '.8rem', color: 'var(--text-2)' }}>{h.label}<br /><span style={{ color: 'var(--text-3)', fontSize: '.72rem' }}>All time: {monthTitle(h.from)} – {monthTitle(h.through)}</span></span>
          </div>
          {/* Every month since the household's first bill, newest first. */}
          <div className="tr-strip">
            {[...r.stamps].reverse().map(s => (
              <div key={s.month} style={{ textAlign: 'center' }}>
                <span className={`rr-stamp ${s.stamp ?? 'none'}${s.onboarding ? ' onboarding' : ''}`} title={stampTitle(s)}>{stampText(s)}</span>
                <span className="rr-stamp-month">{shortMonth(s.month)}{stripYear(s.month, h.through) ?? ''}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-title" style={{ marginBottom: 10 }}>Months, all time</div>
          <KV k={PAYMENT_STAMP_LABEL['paid_on_time']} v={h.onTime} />
          <KV k={PAYMENT_STAMP_LABEL['paid_late']} v={h.paidLate} />
          <KV k={PAYMENT_STAMP_LABEL.partial} v={h.partial} />
          <KV k={PAYMENT_STAMP_LABEL.outstanding} v={h.outstanding} />
          {h.workTrade > 0 && <KV k="Covered by work trade (on time)" v={h.workTrade} />}
          <KV k="Not counted (not due yet, or the onboarding month)" v={h.notCounted} />
        </div>
        <div className="card">
          <div className="card-title" style={{ marginBottom: 10 }}>Now</div>
          <KV k="Balance owed" v={<strong style={{ color: r.balanceOwedNow > 0 ? 'var(--gold)' : 'var(--text-0)' }}>{money(r.balanceOwedNow)}</strong>} />
          <KV k="Account credit applied (all time)" v={money(r.creditApplied)} />
          <KV k="Late fees charged" v={`${money(r.lateFees.charged)}${r.lateFees.months ? ` · ${r.lateFees.months} month${r.lateFees.months === 1 ? '' : 's'}` : ''}`} />
          <KV k="Late fees still owed" v={money(r.lateFees.owed)} />
          {r.leases.some(l => l.evictionMode) ? <KV k="Space" v={<span className="rr-flag">Eviction mode</span>} />
            : r.leases.some(l => l.delinquent) ? <KV k="Space" v={<span className="rr-flag">Delinquent</span>} /> : null}
        </div>
      </div>

      <div className="card tr-section">
        <h2 className="card-title">Lease</h2>
        {r.leases.length === 0 ? <div style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>No lease with you.</div> : r.leases.map(l => (
          <div key={l.leaseId} style={{ marginBottom: 10 }}>
            <KV k={`${l.propertyName} · ${l.unitNumber}`} v={`${l.leaseTypeLabel}${l.status === 'active' ? '' : ' (ended)'}`} />
            <KV k="Term" v={`${dayWord(l.startDate, '')} – ${l.endDate ? dayWord(l.endDate, '') : 'month to month'}`} />
            <KV k="Rent" v={`${money(l.rentAmount)} due on day ${l.rentDueDay}`} />
            {/* 10/12: the first late day from the server (services/lateness firstLateDay), never page arithmetic. */}
            <KV k="Grace period" v={`${l.graceDays} day${l.graceDays === 1 ? '' : 's'} (${l.graceSourceLabel}) — late from ${l.firstLateDayText}`} />
            <KV k="Late fees" v={l.lateFeeTerms} />
            {l.existingTenancy && <KV k="Moved onto GAM" v="Existing tenancy — the first month is good news only" />}
          </div>
        ))}
      </div>

      <div className="card tr-section">
        <h2 className="card-title">How late</h2>
        {r.howLate.months.length === 0 ? (
          <div style={{ fontSize: '.82rem', color: 'var(--text-2)' }}>No month has gone past its grace period.</div>
        ) : (
          <>
            <div className="tr-pattern">{r.howLate.pattern ?? 'Nothing paid late yet — the months below are still open'}</div>
            <div style={{ fontSize: '.76rem', color: 'var(--text-3)', marginBottom: 10 }}>
              {r.howLate.average !== null ? `Average ${r.howLate.average} days past grace` : 'Days past grace so far'}
              {r.howLate.worst ? ` · worst ${monthWord(r.howLate.worst.month)} (${r.howLate.worst.daysPastGrace} days)` : ''}
              {r.howLate.trend && r.howLate.trend.recent !== null && r.howLate.trend.earlier !== null
                ? ` · last 3 late months average ${r.howLate.trend.recent} days, before that ${r.howLate.trend.earlier}` : ''}
            </div>
            <div className="tr-bars" style={{ marginBottom: 12 }}>
              {r.howLate.distribution.map(d => (
                <div key={d.bucket} className="tr-bar">
                  <span>{d.label}</span>
                  <span className="tr-bar-track"><span className={`tr-bar-fill${d.bucket === 'within_grace' ? ' ok' : ''}`} style={{ display: 'block', width: `${(d.months / maxBucket) * 100}%` }} /></span>
                  <span style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{d.months}</span>
                </div>
              ))}
            </div>
            <div className="tr-history-wrap">
              <table className="tr-history">
                <thead><tr><th>Month</th><th>Late from</th><th>Paid in full</th><th className="num">Days past grace</th></tr></thead>
                <tbody>
                  {r.howLate.months.map(m => (
                    <tr key={m.month}>
                      <td>{monthTitle(m.month)}</td>
                      <td>{m.firstLateDay ? dayWord(m.firstLateDay, '') : '—'}</td>
                      <td>{m.stillOpen ? 'Not yet' : m.paidInFullOn ? dayWord(m.paidInFullOn, '') : '—'}</td>
                      <td className="num">{m.daysPastGrace}{m.stillOpen ? ' so far' : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="tr-grid">
        <div className="card">
          <div className="card-title" style={{ marginBottom: 10 }}>Paid in parts</div>
          <KV k="Months paid in parts" v={r.partials.months} />
          <KV k="Average first payment" v={r.partials.averageFirstPayment === null ? '—' : money(r.partials.averageFirstPayment)} />
          <KV k="Average first payment, share of the bill" v={r.partials.averageFirstPercent === null ? '—' : `${r.partials.averageFirstPercent}%`} />
          <KV k="Average days to pay the rest" v={r.partials.averageDaysToSettle === null ? '—' : r.partials.averageDaysToSettle} />
          {r.partials.open.map(o => (
            <KV key={o.month} k={`${monthWord(o.month)} still owes`} v={`${money(o.owed)}${o.daysSinceFirstPayment !== null ? ` · ${o.daysSinceFirstPayment} days since the first payment` : ''}`} />
          ))}
        </div>
        {(r.workTrade.valueCovered > 0 || r.workTrade.agreements.length > 0) && (
          <div className="card">
            <div className="card-title" style={{ marginBottom: 10 }}>Work trade</div>
            <KV k="Months covered in full" v={r.workTrade.monthsCovered} />
            <KV k="Value covered" v={money(r.workTrade.valueCovered)} />
            {r.workTrade.byCharge.map(b => <KV key={b.label} k={b.label} v={money(b.amount)} />)}
            {r.workTrade.hours.map(x => <KV key={x.month} k={`${monthWord(x.month)} hours`} v={`${x.worked} of ${x.target}`} />)}
          </div>
        )}
      </div>

      <div className="card tr-section">
        <h2 className="card-title">Every charge</h2>
        <div className="tr-history-wrap">
          <table className="tr-history">
            <thead><tr><th>Due</th><th>What it's for</th><th>Space</th><th className="num">Charged</th><th className="num">Paid</th><th>Paid on</th><th>How paid</th><th className="num">Days past grace</th><th className="num">Owed</th></tr></thead>
            <tbody>
              {r.history.map(l => {
                const isGroup = !!l.lateFeeCount && l.lateFeeCount > 1
                const open = isGroup && openFees.has(l.paymentId)
                return [
                  <tr key={l.paymentId}>
                    <td>{dayWord(l.dueDate, '')}</td>
                    <td>
                      {isGroup ? `Late fees, ${l.lateFeeCount} days${l.lateFeeFrom && l.lateFeeTo ? ` (${dayWord(l.lateFeeFrom, '')} – ${dayWord(l.lateFeeTo, '')})` : ''}` : l.label}
                      {isGroup && (
                        <button className="tr-fee-toggle rr-noprint" style={{ marginLeft: 6 }}
                          onClick={() => setOpenFees(prev => { const n = new Set(prev); n.has(l.paymentId) ? n.delete(l.paymentId) : n.add(l.paymentId); return n })}>
                          {open ? 'hide days' : 'show days'}
                        </button>
                      )}
                      {l.detail && !isGroup && <span className="rr-sub">{l.detail}</span>}
                    </td>
                    <td>{l.unitNumber ?? '—'}</td>
                    <td className="num">{money(l.charged)}</td>
                    <td className="num">{l.workTrade > 0 ? 'Work trade' : money(l.paid + l.credit)}{l.credit > 0 && <span className="rr-sub">incl. {money(l.credit)} credit</span>}</td>
                    <td>{l.paidOn ? dayWord(l.paidOn, '') : '—'}</td>
                    <td>{l.howPaid ?? '—'}</td>
                    <td className="num">{lineLateness(l)}</td>
                    <td className="num">{l.owed > 0 ? <span className="rr-owed">{money(l.owed)}</span> : money(0)}</td>
                  </tr>,
                  ...(open ? (l.lateFees ?? []).map(f => (
                    <tr key={`${l.paymentId}-${f.paymentId}`} className="tr-fees">
                      <td />
                      <td>Late fee</td>
                      <td>{f.unitNumber ?? '—'}</td>
                      <td className="num">{money(f.charged)}</td>
                      <td className="num">{money(f.paid + f.credit)}</td>
                      <td>{f.paidOn ? dayWord(f.paidOn, '') : '—'}</td>
                      <td>{f.howPaid ?? '—'}</td>
                      <td className="num">—</td>
                      <td className="num">{money(f.owed)}</td>
                    </tr>
                  )) : []),
                ]
              })}
            </tbody>
          </table>
        </div>
      </div>

      {(r.imported?.length ?? 0) > 0 && (
        <div className="card tr-section">
          <h2 className="card-title">Imported history</h2>
          {/* 10/12 (Nic) review: no "made before the first bill on GAM" — the
              import takes any date, so the page never claims one it did not check. */}
          <p className="tr-note">
            Payments brought in from {[...new Set(r.imported!.map(l => l.importedFrom))].join(', ')}.
            Shown for the record; they never count toward payment health.
          </p>
          <div className="tr-history-wrap">
            <table className="tr-history">
              <thead><tr><th>Paid on</th><th>What it's for</th><th>Space</th><th className="num">Amount</th><th>How paid</th><th>Source</th></tr></thead>
              <tbody>
                {r.imported!.map(l => (
                  <tr key={l.paymentId}>
                    <td>{dayWord(l.paidOn, '')}</td>
                    <td>{l.label}{l.reference && <span className="rr-sub">Reference {l.reference}</span>}</td>
                    <td>{l.unitNumber ?? '—'}</td>
                    <td className="num">{money(l.amount)}</td>
                    <td>{l.method ?? '—'}</td>
                    <td><span className="tr-imported-tag">Imported from {l.importedFrom}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
