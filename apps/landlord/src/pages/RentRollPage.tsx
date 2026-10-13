import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronRight, Printer, Download, ScrollText } from 'lucide-react'
import {
  PAYMENT_STAMPS, PAYMENT_STAMP_LABEL, RENT_ROLL_MOVED_OUT_RULES, RENT_ROLL_MOVED_OUT_LABEL, RENT_ROLL_MOVED_OUT_NOTE, RENT_ROLL_MOVED_OUT_DEFAULT,
  type PaymentStamp, type RentRollMovedOutRule,
} from '@gam/shared'
import { api } from '../lib/api'
import { toast } from '../components/dialogs'
import { SearchBox } from '../components/ListControls'
import { money, monthTitle, localToday, dayWord } from '../lib/creditDesk'
import {
  STAMP_COUNT_KEY, shortMonth, stripYear, stampText, stampTitle, statusNote, healthText, healthColor, lineLateness, csvLine, downloadText,
  type StampMonth, type HealthFigure, type ChargeLine, type StampCounts,
} from '../lib/paymentStamps'
import '../styles/rent-roll.css'

/**
 * THE RENT ROLL (10/12, Nic) — one page for who owes, who paid, how late and
 * how each household pays. It replaces the old Rent Roll (a unit list with the
 * unit's listed rent; a row click that did nothing) and the Payments ledger as
 * the place to look.
 *
 *   "property FOLDERS like the Balances page (a single property opens
 *    automatically; each folder header shows that property's month counts) …
 *    name, unit(s), lease rent (from the LEASE), Charged (includes late fees,
 *    with a small 'incl. $X late fees' note), Paid, Owed, Status (color),
 *    Payment health (%), and a strip of monthly stamps (colored) … Clicking a
 *    name opens the tenant report."
 *   10/12 (Nic): payment health and a tenant's history are ALL-TIME (since
 *    the household joined GAM), not 12 months — "the full stamp history as a
 *    horizontally scrolling strip (newest first visible), name column beside
 *    it not over it."
 *
 * Every figure is the server's (GET /api/balances/rent-roll — the one
 * payment-health definition). Totals across people show only when the server
 * sent them (decisions #25); this page never adds rows up. The name column
 * sits BESIDE the columns that scroll, never stuck over them; the strip runs
 * newest month first right after the month's figures, so the newest is in
 * view without scrolling and older months are further right. Under 640px
 * every household is a card with its own sideways strip.
 *
 * 10/12 (Nic): "who stays on the Rent Roll after moving out = LANDLORD'S
 * CHOICE (a setting on the page: billed in last 12 months / while they owe /
 * all time)." The setting sits under the bar, one per company; the owner
 * changes it (PUT /api/balances/rent-roll/moved-out), everyone else reads it.
 */

interface RollRow {
  householdId: string
  name: string
  propertyId: string | null
  units: string[]
  leaseRent: number | null
  current: StampMonth | null
  stamps: StampMonth[]
  health: HealthFigure
  delinquent: boolean
  evictionMode: boolean
  workTrade: boolean
  lines: ChargeLine[]
}
interface Money { charged: number; chargedLateFees: number; paid: number; credit: number; workTrade: number; owed: number }
interface Folder { propertyId: string | null; propertyName: string | null; occupied: number; rows: RollRow[]; counts: StampCounts[]; totals?: Money }
/** One company's choice of who stays on the page after moving out. */
interface MovedOut { landlordId: string; companyName: string; rule: RentRollMovedOutRule; ruleLabel: string }
interface RentRoll {
  through: string; months: string[]; properties: Folder[]; counts: StampCounts[]; totals?: Money
  leaseRent?: { expected: number; tradedForWork: number }
  movedOut?: MovedOut[]
  /** The owner (or GAM acting for them) may change the moved-out setting; everyone else reads it. */
  canChangeMovedOut?: boolean
}

/** The last 24 bill months, newest first, for the picker. */
function pickerMonths(today = localToday()): string[] {
  const out: string[] = []
  let y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7))
  for (let i = 0; i < 24; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m -= 1
    if (m === 0) { m = 12; y -= 1 }
  }
  return out
}

/** "3 late · 1 partial · 2 outstanding" for one month's counts (late = paid late + outstanding). */
export function countsText(c: StampCounts | undefined): string {
  if (!c) return ''
  const bits: string[] = []
  if (c.paidOnTime) bits.push(`${c.paidOnTime} on time`)
  if (c.paidLate) bits.push(`${c.paidLate} paid late`)
  if (c.partial) bits.push(`${c.partial} partial`)
  if (c.outstanding) bits.push(`${c.outstanding} outstanding`)
  if (c.due) bits.push(`${c.due} not due yet`)
  return bits.join(' · ')
}

const lateCount = (c: StampCounts | undefined) => (c ? c.paidLate + c.outstanding : 0)

/** The empty page's sentence for the companies' moved-out rules. */
export function movedOutNote(rules: readonly MovedOut[] | undefined): string {
  const distinct = [...new Set((rules ?? []).map(r => r.rule))]
  if (distinct.length === 1) return RENT_ROLL_MOVED_OUT_NOTE[distinct[0]]
  if (distinct.length > 1) return 'Households on an occupied space, and those who moved out that each company keeps on the Rent Roll, appear here.'
  // The default rule's sentence, from the one default (packages/shared), never its value typed again here.
  return RENT_ROLL_MOVED_OUT_NOTE[RENT_ROLL_MOVED_OUT_DEFAULT]
}

/**
 * 10/12 (Nic): who stays on the Rent Roll after moving out — the landlord's
 * choice, one per company (an account with one company sees one picker).
 */
function MovedOutSetting({ rules, canChange }: { rules: MovedOut[]; canChange: boolean }) {
  const qc = useQueryClient()
  const [saving, setSaving] = useState<string | null>(null)
  if (!rules.length) return null
  const many = rules.length > 1
  const save = async (r: MovedOut, rule: RentRollMovedOutRule) => {
    if (rule === r.rule) return
    setSaving(r.landlordId)
    try {
      await api.put('/balances/rent-roll/moved-out', { landlordId: r.landlordId, rule })
      await qc.invalidateQueries('rent-roll')
      toast(`Moved-out households now stay: ${RENT_ROLL_MOVED_OUT_LABEL[rule].toLowerCase()}.`)
    } catch (e: any) {
      toast.error(e?.response?.data?.error ?? 'The setting could not be saved. Try again.')
    } finally {
      setSaving(null)
    }
  }
  return (
    <div className="rr-moved-out rr-noprint">
      {rules.map(r => (
        <label key={r.landlordId} className="rr-moved-out-item">
          <span>{many ? `${r.companyName}: keep moved-out households` : 'Keep moved-out households'}</span>
          {canChange ? (
            <select className="form-select" value={r.rule} disabled={saving === r.landlordId}
              onChange={e => save(r, e.target.value as RentRollMovedOutRule)}>
              {RENT_ROLL_MOVED_OUT_RULES.map(x => <option key={x} value={x}>{RENT_ROLL_MOVED_OUT_LABEL[x]}</option>)}
            </select>
          ) : (
            <span className="rr-moved-out-value" title="The account owner chooses this.">{r.ruleLabel}</span>
          )}
        </label>
      ))}
    </div>
  )
}

/**
 * 10/12: the server sends the strip oldest first (every month since the first
 * bill on the page); the page shows it newest first, so the newest month sits
 * beside the month's figures and older months are a scroll to the right.
 */
export function newestFirst<T>(xs: readonly T[] | undefined): T[] {
  return [...(xs ?? [])].reverse()
}

function Stamp({ s }: { s: StampMonth }) {
  const cls = s.stamp ?? 'none'
  return (
    <span className={`rr-stamp ${cls}${s.onboarding ? ' onboarding' : ''}`} title={stampTitle(s)}
      aria-label={stampTitle(s)}>{stampText(s)}</span>
  )
}

function StatusCell({ r }: { r: RollRow }) {
  const c = r.current
  const stamp: PaymentStamp | null = c?.stamp ?? null
  return (
    <>
      <span className={`rr-pill ${stamp ?? 'none'}`}>{stamp ? PAYMENT_STAMP_LABEL[stamp] : 'Nothing billed'}</span>
      {r.evictionMode ? <span className="rr-flag">Eviction mode</span>
        : r.delinquent ? <span className="rr-flag">Delinquent</span> : null}
      <span className="rr-sub">{statusNote(c) ?? ' '}</span>
    </>
  )
}

export function RentRollPage() {
  const navigate = useNavigate()
  const months = useMemo(() => pickerMonths(), [])
  const [through, setThrough] = useState(months[0])
  const [search, setSearch] = useState('')
  const [openProps, setOpenProps] = useState<Set<string>>(() => new Set())
  const [openRow, setOpenRow] = useState<string | null>(null)
  const { data, isLoading, error, refetch, isFetching, isPreviousData } = useQuery(
    ['rent-roll', through],
    () => api.get(`/balances/rent-roll?through=${through}`).then(r => r.data.data as RentRoll),
    {
      keepPreviousData: true, refetchOnWindowFocus: true,
      // A refusal (no "View all payments") will not change on a retry: say it at once.
      retry: (count: number, e: any) => { const st = e?.response?.status; return !(st >= 400 && st < 500) && count < 2 },
    })

  const q = search.trim().toLowerCase()
  const folders = (data?.properties ?? []).map(f => ({
    ...f,
    rows: q ? f.rows.filter(r => r.name.toLowerCase().includes(q) || r.units.some(u => u.toLowerCase().includes(q))
      || String(f.propertyName ?? '').toLowerCase().includes(q)) : f.rows,
  })).filter(f => f.rows.length > 0)
  const single = (data?.properties.length ?? 0) === 1
  const isOpen = (f: Folder) => single || !!q || openProps.has(f.propertyId ?? '')
  const toggle = (id: string) => setOpenProps(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  // Every month, newest first (10/12: all time).
  const strip = newestFirst(data?.months)
  // 10/12: the month the figures on screen are FOR — the data's own month, not
  // the picker's. While a newly picked month loads, the last month's figures
  // stay up (dimmed, below) under their own month's name, never the new one's.
  const shown = data?.through ?? through
  const pickedCounts = data?.counts.find(c => c.month === shown)
  const loadingOther = isPreviousData && !!data
  // 10/12: a row's chevron opens its charges under the folder's tables; on a
  // long folder (Mountain View: 44 households) that is far below the row, so
  // the panel is brought into view when it opens.
  const panelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (openRow) panelRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [openRow])

  const exportCsv = () => {
    if (!data) return
    const head = ['Property', 'Space', 'Tenant', 'Lease rent', 'Charged', 'Late fees', 'Paid', 'Credit', 'Work trade', 'Owed',
      'Status', 'Days past grace', 'Payment health', ...strip.map(monthTitle)]
    const lines = [csvLine(head)]
    for (const f of data.properties) {
      for (const r of f.rows) {
        const c = r.current
        lines.push(csvLine([
          f.propertyName ?? '', r.units.join(' '), r.name, r.leaseRent ?? '',
          c?.charged ?? 0, c?.chargedLateFees ?? 0, c?.paid ?? 0, c?.credit ?? 0, c?.workTrade ?? 0, c?.owed ?? 0,
          c?.stamp ? PAYMENT_STAMP_LABEL[c.stamp] : 'Nothing billed', c?.daysPastGrace ?? 0,
          r.health.percent === null ? '' : `${r.health.percent}%`,
          ...newestFirst(r.stamps).map(s => s.stamp ? `${PAYMENT_STAMP_LABEL[s.stamp]}${s.daysPastGrace > 0 ? ` (+${s.daysPastGrace})` : ''}` : ''),
        ]))
      }
    }
    downloadText(`rent-roll-${data.through}.csv`, lines.join('\n') + '\n')
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">Rent Roll</h1>
          <p className="page-subtitle">Every household by property: what was charged, paid and still owed for the month, how on time they pay since joining GAM, and every month at a glance — newest first, scroll right for older months. Open a name for the full report.</p>
        </div>
      </div>

      <div className="rr-bar rr-noprint">
        <select className="form-select rr-month" value={through} onChange={e => { setThrough(e.target.value); setOpenRow(null) }} aria-label="Month">
          {months.map(m => <option key={m} value={m}>{monthTitle(m)}</option>)}
        </select>
        <SearchBox value={search} onChange={setSearch} placeholder="Search name or space…" />
        <button className="btn btn-primary btn-sm" onClick={() => window.print()} disabled={!data}><Printer size={13} /> Print</button>
        <button className="btn btn-primary btn-sm" onClick={exportCsv} disabled={!data}><Download size={13} /> Export CSV</button>
      </div>
      {data && !error && <MovedOutSetting rules={data.movedOut ?? []} canChange={data.canChangeMovedOut === true} />}

      {data && !error && (
        <div className="rr-summary" style={{ opacity: loadingOther ? 0.55 : 1, transition: 'opacity .15s' }} aria-busy={loadingOther || undefined}>
          {data.leaseRent && (
            <div className="rr-summary-card">
              <div className="rr-summary-label">Lease rent / month</div>
              <div className="rr-summary-value gold">{money(data.leaseRent.expected)}</div>
              {data.leaseRent.tradedForWork > 0 && <div className="rr-summary-sub">+ {money(data.leaseRent.tradedForWork)} traded for work</div>}
            </div>
          )}
          {data.totals && (
            <>
              <div className="rr-summary-card">
                <div className="rr-summary-label">Charged · {shortMonth(shown)}</div>
                <div className="rr-summary-value">{money(data.totals.charged)}</div>
                {data.totals.chargedLateFees > 0 && <div className="rr-summary-sub">incl. {money(data.totals.chargedLateFees)} late fees</div>}
              </div>
              <div className="rr-summary-card">
                <div className="rr-summary-label">Paid</div>
                <div className="rr-summary-value">{money(data.totals.paid + data.totals.credit)}</div>
                {data.totals.credit > 0 && <div className="rr-summary-sub">incl. {money(data.totals.credit)} account credit</div>}
                {data.totals.workTrade > 0 && <div className="rr-summary-sub">+ {money(data.totals.workTrade)} work trade</div>}
              </div>
              <div className="rr-summary-card">
                <div className="rr-summary-label">Owed</div>
                <div className="rr-summary-value gold">{money(data.totals.owed)}</div>
              </div>
            </>
          )}
          <div className="rr-summary-card" style={{ flex: 1 }}>
            <div className="rr-summary-label">{monthTitle(shown)}</div>
            <div className="rr-counts" style={{ marginTop: 6 }}>
              {PAYMENT_STAMPS.map(s => (
                <span key={s}><span className={`rr-stamp ${s}`} style={{ minWidth: 0, height: 20 }}>{pickedCounts?.[STAMP_COUNT_KEY[s]] ?? 0}</span> {PAYMENT_STAMP_LABEL[s]}</span>
              ))}
              {(pickedCounts?.workTrade ?? 0) > 0 && <span>· {pickedCounts!.workTrade} covered by work trade</span>}
            </div>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="card" style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
      ) : error ? (
        (error as any)?.response?.status === 403 ? (
          <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-2)' }}>
            The Rent Roll shows every household's payments. It needs the “View all payments” permission — ask the owner if you need it.
          </div>
        ) : (
          <div className="card" style={{ padding: 24, textAlign: 'center' }}>
            <p style={{ color: 'var(--text-2)', marginBottom: 10 }}>The rent roll could not be read.</p>
            <button className="btn btn-primary btn-sm" disabled={isFetching} onClick={() => refetch()}>{isFetching ? 'Reading…' : 'Read it again'}</button>
          </div>
        )
      ) : folders.length === 0 ? (
        <div className="card">
          <div className="empty-state" style={{ padding: 48 }}><ScrollText size={40} /><h3>{q ? 'No one matches' : 'No households yet'}</h3>
            <p>{q ? 'Try another name or space.' : movedOutNote(data?.movedOut)}</p></div>
        </div>
      ) : folders.map(f => {
        const fid = f.propertyId ?? ''
        const open = isOpen(f)
        const fc = f.counts.find(c => c.month === shown)
        const expanded = f.rows.find(r => `${fid}|${r.householdId}` === openRow) ?? null
        return (
          <div key={fid} className="card rr-folder" style={{ opacity: loadingOther ? 0.55 : 1, transition: 'opacity .15s' }}
            aria-busy={loadingOther || undefined}>
            <button className="rr-folder-head" onClick={() => toggle(fid)} aria-expanded={open}>
              {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              {f.propertyName ?? 'No property'}
              <span className="rr-folder-meta">
                {f.occupied} occupied space{f.occupied === 1 ? '' : 's'}{countsText(fc) ? ` · ${shortMonth(shown)}: ${countsText(fc)}` : ''}
              </span>
              {f.totals && (
                <span className="rr-folder-total">
                  Charged {money(f.totals.charged)} · Paid {money(f.totals.paid + f.totals.credit)} · Owed <strong>{money(f.totals.owed)}</strong>
                </span>
              )}
            </button>
            {open && (
              <>
                <div className="rr-split">
                  <div className="rr-fixed">
                    <table className="rr-table">
                      <thead><tr><th>Tenant · Space</th></tr></thead>
                      <tbody>
                        {f.rows.map(r => {
                          const k = `${fid}|${r.householdId}`
                          return (
                            <tr key={k} className={openRow === k ? 'rr-open' : undefined}>
                              <td>
                                <div className="rr-name">
                                  <button className="rr-caret rr-noprint" aria-label={openRow === k ? 'Hide the month’s charges' : 'Show the month’s charges'}
                                    onClick={() => setOpenRow(openRow === k ? null : k)}>
                                    {openRow === k ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                                  </button>
                                  <div style={{ minWidth: 0 }}>
                                    <button className="rr-name-link" title="Open the payment report" onClick={() => navigate(`/tenants/${r.householdId}/report`)}>{r.name}</button>
                                    <span className="rr-space">{r.units.join(', ') || '—'}{r.workTrade ? ' · work trade' : ''}</span>
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                      <tfoot><tr><td>Households by month</td></tr></tfoot>
                    </table>
                  </div>
                  <div className="rr-scroll" tabIndex={0} role="region"
                    aria-label={`${f.propertyName ?? 'No property'}: the month's figures and every month, newest first`}>
                    <table className="rr-table">
                      <thead>
                        <tr>
                          <th className="num">Lease rent</th>
                          <th className="num">Charged</th>
                          <th className="num">Paid</th>
                          <th className="num">Owed</th>
                          <th>Status</th>
                          <th className="num">Health</th>
                          {strip.map(m => {
                            const late = lateCount(f.counts.find(c => c.month === m))
                            const yr = stripYear(m, shown)
                            return (
                              <th key={m} className="stampcol" title={monthTitle(m)}>
                                <span className="rr-month-head">{shortMonth(m)}{yr && <span className="rr-month-year">{yr}</span>}{late > 0 && <span className="rr-month-late">{late} late</span>}</span>
                              </th>
                            )
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {f.rows.map(r => {
                          const k = `${fid}|${r.householdId}`
                          const c = r.current
                          return (
                            <tr key={k} className={openRow === k ? 'rr-open' : undefined}>
                              <td className="num">{r.leaseRent === null ? <span className="rr-zero">—</span> : money(r.leaseRent)}</td>
                              <td className="num">{c ? money(c.charged) : <span className="rr-zero">—</span>}
                                <span className="rr-sub">{c && (c.chargedLateFees ?? 0) > 0 ? `incl. ${money(c.chargedLateFees!)} late fees` : ' '}</span></td>
                              <td className="num">{c ? money(c.paid + c.credit) : <span className="rr-zero">—</span>}
                                <span className="rr-sub">{c && c.workTrade > 0 ? `+ ${money(c.workTrade)} work trade` : c && c.credit > 0 ? `incl. ${money(c.credit)} credit` : ' '}</span></td>
                              <td className="num">{c && c.owed > 0 ? <span className="rr-owed">{money(c.owed)}</span> : <span className="rr-zero">{c ? money(0) : '—'}</span>}</td>
                              <td><StatusCell r={r} /></td>
                              <td className="num" title={r.health.label}><span style={{ color: healthColor(r.health.percent), fontWeight: 700 }}>{healthText(r.health)}</span>
                                <span className="rr-sub">{r.health.counted ? `${r.health.onTime} of ${r.health.counted} mo` : ' '}</span></td>
                              {newestFirst(r.stamps).map(s => <td key={s.month} className="stampcol"><Stamp s={s} /></td>)}
                            </tr>
                          )
                        })}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan={6} />
                          {strip.map(m => {
                            const c = f.counts.find(x => x.month === m)
                            return (
                              <td key={m} className="stampcol">
                                <span className="rr-foot-counts" title={countsText(c)}>
                                  {PAYMENT_STAMPS.filter(s => (c?.[STAMP_COUNT_KEY[s]] ?? 0) > 0).map(s => (
                                    <span key={s}>{c![STAMP_COUNT_KEY[s]]} {stampText({ stamp: s, daysPastGrace: 0 })}</span>
                                  ))}
                                </span>
                              </td>
                            )
                          })}
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>

                <div className="rr-cards">
                  {f.rows.map(r => {
                    const k = `${fid}|${r.householdId}`
                    const c = r.current
                    return (
                      <div key={k} className="rr-card">
                        <div className="rr-card-top">
                          <div style={{ minWidth: 0 }}>
                            <button className="rr-name-link" onClick={() => navigate(`/tenants/${r.householdId}/report`)}>{r.name}</button>
                            <span className="rr-space">{r.units.join(', ') || '—'}{r.leaseRent !== null ? ` · ${money(r.leaseRent)}/mo` : ''}</span>
                          </div>
                          <div style={{ textAlign: 'right' }}><StatusCell r={r} /></div>
                        </div>
                        <div className="rr-card-figs">
                          <div>Charged<strong>{c ? money(c.charged) : '—'}</strong></div>
                          <div>Paid<strong>{c ? money(c.paid + c.credit) : '—'}</strong></div>
                          <div>Owed<strong>{c ? money(c.owed) : '—'}</strong></div>
                        </div>
                        {/* Every month, newest first; the strip scrolls sideways inside the card. */}
                        <div className="rr-card-stamps" tabIndex={0} role="region" aria-label={`${r.name}: every month, newest first`}>
                          {newestFirst(r.stamps).map(s => (
                            <div key={s.month} className="rr-card-stamp"><Stamp s={s} /><span className="rr-stamp-month">{shortMonth(s.month)}{stripYear(s.month, shown) ?? ''}</span></div>
                          ))}
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: '.74rem', color: 'var(--text-2)' }}>
                          <span>Health <strong style={{ color: healthColor(r.health.percent) }}>{healthText(r.health)}</strong>{r.health.counted ? ` · ${r.health.onTime} of ${r.health.counted} mo` : ''}</span>
                          <button className="btn btn-primary btn-sm" onClick={() => setOpenRow(openRow === k ? null : k)}>{openRow === k ? 'Hide charges' : 'Charges'}</button>
                        </div>
                        {openRow === k && <MonthLines row={r} through={shown} />}
                      </div>
                    )
                  })}
                </div>

                {expanded && <div className="rr-split-only" ref={panelRef}><MonthLines row={expanded} through={shown} /></div>}
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** The picked month's charges for one household: what each is for, charged, paid, when and how. */
function MonthLines({ row, through }: { row: RollRow; through: string }) {
  return (
    <div className="rr-lines">
      <div className="rr-lines-head">{row.name} · {monthTitle(through)}</div>
      {row.lines.length === 0 ? (
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>Nothing billed for this month.</div>
      ) : (
        <div className="rr-lines-wrap">
          <table className="rr-lines-table">
            <thead><tr><th>What it's for</th><th>Space</th><th className="num">Charged</th><th className="num">Paid</th><th className="num">Owed</th><th>Paid on</th><th>How</th><th>Days past grace</th></tr></thead>
            <tbody>
              {row.lines.map(l => (
                <tr key={l.paymentId}>
                  <td>{l.label}{l.detail && <span className="rr-sub">{l.detail}</span>}</td>
                  <td>{l.unitNumber ?? '—'}</td>
                  <td className="num">{money(l.charged)}</td>
                  <td className="num">{l.workTrade > 0 ? 'Work trade' : money(l.paid + l.credit)}</td>
                  <td className="num">{money(l.owed)}</td>
                  <td>{l.paidOn ? dayWord(l.paidOn) : '—'}</td>
                  <td>{l.howPaid ?? '—'}</td>
                  <td>{lineLateness(l)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// Exported for the tests.
export { pickerMonths }
export type { RentRoll, RollRow }
