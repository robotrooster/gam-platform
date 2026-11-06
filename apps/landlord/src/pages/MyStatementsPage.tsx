/**
 * What my manager owes me — the owner's own statement and portfolio.
 *
 * 11/01. PM readiness item 4. The server has computed a full owner statement
 * for a while and, as of tonight, emails it as a PDF on the 3rd of each month —
 * but `/pm/my-statements` and `/pm/my-portfolio` had NO screen reading either.
 * An owner whose park is run by a management company could not look at their
 * own money between emails.
 *
 * This is for the OWNER, not the manager. The manager has their own screen that
 * builds these; this is the other side of it, in the portal the owner already
 * signs into. (The separate PM-company portal was retired on 10/23 and
 * redirects here, which is why there is no third app.)
 *
 * Nic's directive behind the portfolio half (S645): "I don't want to have to
 * log in to see half my properties and log into a different thing to see the
 * other half... I want to be able to do side-by-side comparison on who's
 * filling vacancies faster, who's handling evictions promptly, who's collecting
 * on time." So the comparison is every manager AND the properties the owner
 * runs themselves, in one table — a manager is only judged against something if
 * the self-managed column is there too.
 *
 * Two numbers are deliberately NOT invented here. An occupancy or on-time rate
 * the server returned as null is printed as "not measured yet" and never as 0% —
 * a park with no rent roll yet would otherwise read as a manager collecting
 * nothing. And evictions resolved is always null today, so it says so rather
 * than showing a dash that looks like zero.
 */
import { useState, CSSProperties } from 'react'
import { useQuery } from 'react-query'
import { apiGet, openPdfInNewTab } from '../lib/api'
import {
  FileText, Download, TrendingUp, Building2, CheckCircle2, Clock,
} from 'lucide-react'

const money = (n: any) => {
  const v = Number(n ?? 0)
  const s = `$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return v < 0 ? `(${s})` : s
}
const pct = (n: number | null) => n == null ? null : `${n.toFixed(0)}%`
const lbl: CSSProperties = { fontSize: '.75rem', color: 'var(--text-3)', marginBottom: 4, display: 'block' }

/** A figure the server said it could not measure. Never a zero. */
function NotMeasured() {
  return <span style={{ color: 'var(--text-3)', fontSize: '.85em' }}>not measured yet</span>
}

interface StatementBundle {
  pmCompanyId: string
  pmCompanyName: string
  entityName: string | null
  statement: {
    periodMonth: string
    properties: Array<{
      propertyId: string; propertyName: string
      grossCollected: number; collectedThroughGam: number; collectedDirectly: number
      returnedOrDisputed: number
      ownerShare: number; managementFee: number; expenses: number; net: number
    }>
    totals: {
      grossCollected: number; collectedThroughGam: number; collectedDirectly: number
      returnedOrDisputed: number
      ownerShare: number; managementFee: number; expenses: number; net: number
    }
  }
  delivery: { sentAt: string | null; status?: string | null } | null
}

function thisMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function monthChoices(n = 13): string[] {
  const out: string[] = []
  const d = new Date()
  for (let i = 0; i < n; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
    d.setMonth(d.getMonth() - 1)
  }
  return out
}

const monthName = (m: string) => {
  const [y, mm] = m.split('-')
  return new Date(Number(y), Number(mm) - 1, 1)
    .toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

export function MyStatementsPage() {
  const [month, setMonth] = useState(thisMonth())
  const [tab, setTab] = useState<'statements' | 'portfolio'>('statements')

  return (
    <div className="page">
      <div className="page-head">
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: 0 }}>
          <FileText size={22} /> My Statements
        </h1>
        <p style={{ color: 'var(--text-3)', margin: '6px 0 0', maxWidth: '64ch' }}>
          What each management company collected on your properties, what they kept,
          and what came to you. One statement per manager — separate fees, separate
          people to ring about them.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '16px 0' }}>
        <button className={tab === 'statements' ? 'btn btn-primary' : 'btn btn-ghost'}
                style={{ fontSize: '.85rem' }} onClick={() => setTab('statements')}>
          Monthly statement
        </button>
        <button className={tab === 'portfolio' ? 'btn btn-primary' : 'btn btn-ghost'}
                style={{ fontSize: '.85rem' }} onClick={() => setTab('portfolio')}>
          Compare my managers
        </button>
      </div>

      {tab === 'statements' && <Statements month={month} onMonth={setMonth} />}
      {tab === 'portfolio' && <Portfolio />}
    </div>
  )
}

// ── the monthly statement ─────────────────────────────────────

function Statements({ month, onMonth }: { month: string; onMonth: (m: string) => void }) {
  const { data: bundles = [], isLoading, error } = useQuery<StatementBundle[]>(
    ['my-statements', month], () => apiGet(`/pm/my-statements?month=${month}`),
    { retry: false })

  if (isLoading) return <div className="card">Loading…</div>

  // An account with no managed entity gets a sentence, not a stack trace.
  if (error) return (
    <div className="card" style={{ textAlign: 'center', padding: 30 }}>
      <Building2 size={28} style={{ color: 'var(--text-3)' }} />
      <h3 style={{ marginBottom: 6 }}>No managed properties</h3>
      <p style={{ color: 'var(--text-3)', margin: '0 auto', maxWidth: '46ch' }}>
        Statements appear here when a management company runs one of your
        properties. Everything you run yourself is on your own reports.
      </p>
    </div>
  )

  return (
    <>
      <div style={{ marginBottom: 14, maxWidth: 240 }}>
        <label style={lbl}>Month</label>
        <select value={month} onChange={e => onMonth(e.target.value)}>
          {monthChoices().map(m => <option key={m} value={m}>{monthName(m)}</option>)}
        </select>
      </div>

      {bundles.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: 30 }}>
          <p style={{ color: 'var(--text-3)', margin: 0 }}>
            No manager was running your properties in {monthName(month)}.
          </p>
        </div>
      )}

      <div style={{ display: 'grid', gap: 16 }}>
        {bundles.map(b => <OneStatement key={b.pmCompanyId + b.statement.periodMonth} bundle={b} />)}
      </div>
    </>
  )
}

function OneStatement({ bundle }: { bundle: StatementBundle }) {
  const t = bundle.statement.totals
  const sent = bundle.delivery?.sentAt

  return (
    <section className="card">
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ fontSize: '1.05rem', margin: 0 }}>{bundle.pmCompanyName}</h2>
          <div style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>
            {bundle.entityName ? `${bundle.entityName} · ` : ''}
            {monthName(bundle.statement.periodMonth)}
          </div>
        </div>
        <button className="btn btn-ghost" style={{ fontSize: '.82rem' }}
                onClick={() => openPdfInNewTab(
                  `/pm/my-statements/pdf?month=${bundle.statement.periodMonth}&pmCompanyId=${bundle.pmCompanyId}`)}>
          <Download size={14} /> PDF
        </button>
      </div>

      {/* The headline is what came to the owner. Everything else explains it. */}
      <div style={{ display: 'grid', gap: 10, marginTop: 14,
                    gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        <Figure label="Net to you" value={t.net} strong />
        <Figure label="Your share of rent" value={t.ownerShare} />
        <Figure label="Management fee" value={-Math.abs(t.managementFee)} />
        <Figure label="Bills paid for you" value={-Math.abs(t.expenses)} />
      </div>

      <div style={{ fontSize: '.8rem', color: 'var(--text-3)', marginTop: 12, maxWidth: '62ch' }}>
        Residents paid <strong>{money(t.grossCollected)}</strong> in all —{' '}
        {money(t.collectedThroughGam)} through GAM and {money(t.collectedDirectly)} taken
        directly by your manager.
        {t.returnedOrDisputed !== 0 && (
          <> A bank return or dispute took back {money(Math.abs(t.returnedOrDisputed))} this
            month; the payment it reverses stays in the month it settled, so no past
            statement is rewritten.</>
        )}
      </div>

      {/* Per property, as a card list so a phone never scrolls sideways. */}
      <div style={{ marginTop: 16 }}>
        <h3 style={{ fontSize: '.85rem', color: 'var(--text-2)', margin: '0 0 8px' }}>
          Property by property
        </h3>
        <div style={{ display: 'grid', gap: 8 }}>
          {bundle.statement.properties.map(p => (
            <div key={p.propertyId} style={{
              display: 'grid', gap: '2px 12px',
              gridTemplateColumns: 'minmax(0, 1fr) auto',
              borderLeft: '3px solid var(--border-1, #2a2a2a)', paddingLeft: 10,
              fontSize: '.85rem',
            }}>
              <strong style={{ minWidth: 0 }}>{p.propertyName}</strong>
              <span style={{ whiteSpace: 'nowrap' }}>{money(p.net)}</span>
              <span style={{ color: 'var(--text-3)', gridColumn: '1 / -1' }}>
                {money(p.grossCollected)} collected · {money(p.managementFee)} fee ·{' '}
                {money(p.expenses)} bills
              </span>
            </div>
          ))}
          {bundle.statement.properties.length === 0 && (
            <div style={{ color: 'var(--text-3)', fontSize: '.85rem' }}>
              Nothing collected on any property this month.
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 14, fontSize: '.78rem', color: 'var(--text-3)',
                    display: 'flex', gap: 6, alignItems: 'center' }}>
        {sent
          ? <><CheckCircle2 size={13} /> Emailed to you on {new Date(sent).toLocaleDateString('en-US',
              { month: 'short', day: 'numeric', year: 'numeric' })}</>
          : <><Clock size={13} /> This month's statement has not been emailed yet.</>}
      </div>
    </section>
  )
}

function Figure({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: '.72rem', color: 'var(--text-3)', textTransform: 'uppercase',
                    letterSpacing: '.04em' }}>{label}</div>
      <div style={{ fontSize: strong ? '1.4rem' : '1.05rem', fontWeight: strong ? 600 : 400,
                    color: value < 0 ? 'var(--text-2)' : undefined }}>
        {money(value)}
      </div>
    </div>
  )
}

// ── comparing managers ───────────────────────────────────────

interface Portfolio {
  windowStart: string
  windowEnd: string
  managers: Array<{
    pmCompanyId: string | null
    pmCompanyName: string
    propertyCount: number
    unitCount: number
    occupiedUnits: number
    vacantUnits: number
    occupancyPct: number | null
    onTimeRatePct: number | null
    rentDueCount: number
    avgDaysLate: number | null
    avgDaysToFill: number | null
    turnovers: number
    evictionsResolved: null
    properties: Array<{ propertyId: string; propertyName: string; unitCount: number }>
  }>
  totals: { propertyCount: number; unitCount: number; occupiedUnits: number }
  notMeasured: string[]
}

function Portfolio() {
  const [months, setMonths] = useState(12)
  const { data, isLoading, error } = useQuery<Portfolio>(
    ['my-portfolio', months], () => apiGet(`/pm/my-portfolio?months=${months}`), { retry: false })

  if (isLoading) return <div className="card">Loading…</div>
  if (error || !data) return (
    <div className="card" style={{ textAlign: 'center', padding: 30 }}>
      <p style={{ color: 'var(--text-3)', margin: 0 }}>
        Nothing to compare yet — this needs at least one property on the account.
      </p>
    </div>
  )

  return (
    <>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ maxWidth: 200 }}>
          <label style={lbl}>Measured over</label>
          <select value={months} onChange={e => setMonths(Number(e.target.value))}>
            <option value={3}>the last 3 months</option>
            <option value={6}>the last 6 months</option>
            <option value={12}>the last 12 months</option>
            <option value={24}>the last 2 years</option>
          </select>
        </div>
        <div style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>
          {data.totals.propertyCount} propert{data.totals.propertyCount === 1 ? 'y' : 'ies'},{' '}
          {data.totals.unitCount} space{data.totals.unitCount === 1 ? '' : 's'},{' '}
          {data.totals.occupiedUnits} occupied
        </div>
      </div>

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
        {data.managers.map(m => (
          <section key={m.pmCompanyId ?? 'self'} className="card">
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <h3 style={{ margin: 0, fontSize: '1rem', flex: 1 }}>{m.pmCompanyName}</h3>
              {m.pmCompanyId == null && <span className="badge">You</span>}
            </div>
            <div style={{ fontSize: '.8rem', color: 'var(--text-3)', marginBottom: 10 }}>
              {m.propertyCount} propert{m.propertyCount === 1 ? 'y' : 'ies'} · {m.unitCount} space
              {m.unitCount === 1 ? '' : 's'}
            </div>

            <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 12px',
                         margin: 0, fontSize: '.85rem' }}>
              <dt style={{ color: 'var(--text-3)' }}>Occupied</dt>
              <dd style={{ margin: 0, textAlign: 'right' }}>
                {pct(m.occupancyPct) ?? <NotMeasured />}
                <span style={{ color: 'var(--text-3)' }}> ({m.occupiedUnits}/{m.unitCount})</span>
              </dd>

              <dt style={{ color: 'var(--text-3)' }}>Paid on time</dt>
              <dd style={{ margin: 0, textAlign: 'right' }}>
                {/* Null is "nothing was judged", not 0% — showing a zero would
                    libel a manager with no rent roll yet. */}
                {pct(m.onTimeRatePct) ?? <NotMeasured />}
                {m.rentDueCount > 0 && (
                  <span style={{ color: 'var(--text-3)' }}> of {m.rentDueCount}</span>
                )}
              </dd>

              <dt style={{ color: 'var(--text-3)' }}>Average days late</dt>
              <dd style={{ margin: 0, textAlign: 'right' }}>
                {m.avgDaysLate == null ? <NotMeasured /> : m.avgDaysLate.toFixed(1)}
              </dd>

              <dt style={{ color: 'var(--text-3)' }}>Days to fill a space</dt>
              <dd style={{ margin: 0, textAlign: 'right' }}>
                {m.avgDaysToFill == null ? <NotMeasured /> : m.avgDaysToFill.toFixed(0)}
                {m.turnovers > 0 && (
                  <span style={{ color: 'var(--text-3)' }}> over {m.turnovers}</span>
                )}
              </dd>

              <dt style={{ color: 'var(--text-3)' }}>Evictions resolved</dt>
              <dd style={{ margin: 0, textAlign: 'right' }}><NotMeasured /></dd>
            </dl>

            <details style={{ marginTop: 10, fontSize: '.82rem' }}>
              <summary style={{ cursor: 'pointer', color: 'var(--text-3)' }}>
                Which properties
              </summary>
              <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                {m.properties.map(p => (
                  <li key={p.propertyId}>{p.propertyName} ({p.unitCount})</li>
                ))}
              </ul>
            </details>
          </section>
        ))}
      </div>

      {data.notMeasured.length > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <h3 style={{ fontSize: '.85rem', margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: 6 }}>
            <TrendingUp size={14} /> What these numbers don't cover
          </h3>
          {/* Said out loud by the server so this screen never has to invent a
              reason for a null. */}
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: '.82rem', color: 'var(--text-3)' }}>
            {data.notMeasured.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        </div>
      )}
    </>
  )
}
