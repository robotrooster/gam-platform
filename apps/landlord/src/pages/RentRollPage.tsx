import { useState } from 'react'
import { useQuery } from 'react-query'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeft, ChevronDown, ChevronRight, Download, Printer, ScrollText } from 'lucide-react'
import {
  RENT_ROLL_STATUS_COLOR,
  type RentRollHistory, type RentRollHistoryRow, type RentRollMonthCount, type RentRollMonthStatus, type RentRollResident,
  type RentRollStatusColor,
} from '@gam/shared'
import { api } from '../lib/api'
import { useAuth } from '../context/AuthContext'
import { money, monthTitle, localToday, dayWord } from '../lib/creditDesk'
import { shortMonth, stripYear, healthColor, healthText, csvLine, downloadText } from '../lib/paymentStamps'
import {
  RANGE_PICKS, RANGE_PICK_LABEL, viewFromParams, withViewParams, historyPath, rangeKey, monthChoices, customRange, type RangePick,
} from '../components/rentroll/rentRollRange'
import { StatusStamp, monthStampTitle } from '../components/rentroll/StatusStamp'
import {
  useRentRollProperties, chosenProperty, PropertyPickList, householdName, householdNames, reportPath,
} from '../components/rentroll/PropertyPick'
import '../styles/rent-roll.css'
import '../components/rentroll/rentroll.css'

/**
 * THE RENT ROLL — THE HISTORY LOOKUP, ONE PROPERTY AT A TIME (10/13, Nic).
 *
 *   "the payments page is the rent roll for the open month. And the rent roll
 *    page is the historical lookup for previous reportings for quarters or
 *    years or individual months or whatever."
 *   "I don't like having Mountain View and Oak Park options right next to each
 *    other at the top I want them inside of the view … I don't want to be able
 *    to have one property looking one way and one property looking another
 *    way … there's too much … clutter on this page right now."
 *   "for the historical reporting I want the rent rolls to be in order of
 *    space number"
 *
 * Answered 10/13: pick the property first (a company with only one property
 * opens straight to it); one view — quick picks Last month · This quarter ·
 * Last quarter · This year · Last year · All time, or a custom start/end
 * month — applies to whichever property is open (it rides in the address, so
 * changing property keeps it); rows in space order, one per household (a
 * lease), each with Invoiced · Paid · Owed for the range, payment health and
 * one colored stamp per month (green paid, orange paid late +N, yellow
 * partial, red owes +N, gray due; a month with no bill is a dash); people who
 * moved out and still owe sit in a collapsed "Moved out, still owes" folder
 * until paid. The "keep moved-out households" setting and the instruction
 * paragraph are gone. A name opens that household's tenant report.
 *
 * 10/13 (Nic), the afternoon answers: "Bookkeepers SEE the Payments and Rent
 * Roll pages, read-only" — the same page for their properties (the server
 * narrows it), Print and Export kept, the name not a link. "Range totals
 * INCLUDE moved-out folder households" — the summary's Invoiced / Paid / Owed
 * count the "Moved out, still owes" households' bills in the range too (the
 * server's totals).
 *
 * Every figure is the server's (GET /api/balances/rent-roll/history —
 * services/rentRoll, the one payment-health definition, the 10/6 hand-logged
 * rule included). Totals across households show only when the server sent
 * them (decisions #25); this page never adds rows up. 10/12 (Nic), kept: the
 * name column sits BESIDE the columns that scroll, never stuck over them;
 * months run newest first, so the newest is in view and older months are a
 * scroll to the right; while a new range loads, the last figures stay up,
 * dimmed, under their own range's name. Under 640px every household is a card
 * with its own sideways strip.
 */

/** Months as the server sends them (oldest first), newest first — the order on screen. */
export function newestFirst<T>(xs: readonly T[] | undefined): T[] {
  return [...(xs ?? [])].reverse()
}

/** What the range on screen is: "October 2026", "July – September 2026", "All time · March 2026 – October 2026". */
export function rangeTitle(h: Pick<RentRollHistory, 'from' | 'to' | 'allTime'>): string {
  const span = h.from === h.to ? monthTitle(h.from)
    : h.from.slice(0, 4) === h.to.slice(0, 4) ? `${monthTitle(h.from).split(' ')[0]} – ${monthTitle(h.to)}`
      : `${monthTitle(h.from)} – ${monthTitle(h.to)}`
  return h.allTime ? `All time · ${span}` : span
}

/** A month's counts in words, in the status's color ("8 paid", "3 paid late") — only statuses someone earned. */
export function monthCountWords(c: RentRollMonthCount | undefined): Array<{ status: RentRollMonthStatus; text: string; color: RentRollStatusColor }> {
  return (c?.counts ?? []).filter(x => x.households > 0)
    .map(x => ({ status: x.status, text: `${x.households} ${x.label.toLowerCase()}`, color: RENT_ROLL_STATUS_COLOR[x.status] }))
}

/** The line naming the folder households' part of the range totals (the spreadsheet, the summary). */
export const MOVED_OUT_IN_RANGE = 'Moved out, still owes — bills in this range'

/**
 * What the summary says of the folder households' part of its totals (10/13,
 * Nic: "Range totals INCLUDE moved-out folder households"), so the printed
 * page says where the totals' extra comes from. Null when they were billed
 * nothing in the range (or no totals were sent).
 */
export function movedOutInRangeWords(h: Pick<RentRollHistory, 'movedOutTotals' | 'movedOutOwing'>): string | null {
  const mo = h.movedOutTotals
  if (!mo || !h.movedOutOwing.length || (mo.invoiced <= 0 && mo.paid <= 0 && mo.owed <= 0 && mo.workTrade <= 0)) return null
  return `Includes the moved-out households' bills in this range: invoiced ${money(mo.invoiced)} · paid ${money(mo.paid)} · owed ${money(mo.owed)}`
}

/** The rent roll as a spreadsheet: the rows as on screen, then the totals (when sent), then "Moved out, still owes". */
export function rentRollCsv(h: RentRollHistory): string {
  const months = newestFirst(h.months)
  const names = (rs: readonly RentRollResident[]) => householdNames(rs) || householdName(rs)
  const lines = [csvLine(['Space', 'Tenant', 'Moved out', 'Invoiced', 'Late fees', 'Paid', 'Account credit', 'Work trade', 'Owed',
    'Payment health', ...months.map(monthTitle)])]
  for (const r of h.rows) {
    const by = new Map(r.stamps.map(s => [s.month, s]))
    lines.push(csvLine([
      r.spaces.join(' '), names(r.residents), r.movedOut ? 'Yes' : '',
      r.invoiced, r.lateFees, r.paid, r.credit, r.workTrade, r.owed,
      r.health.percent === null ? '' : `${r.health.percent}%`,
      ...months.map(m => by.get(m)?.statusLabel ?? ''),
    ]))
  }
  if (h.totals) {
    const t = h.totals
    // 10/13 (Nic): "Range totals INCLUDE moved-out folder households" — their
    // bills in the range on a line of their own, above the Total, so the
    // Total is the lines above it added up (10/13 review: it was not).
    const mo = h.movedOutTotals
    if (mo && h.movedOutOwing.length) {
      lines.push(csvLine(['', MOVED_OUT_IN_RANGE, '', mo.invoiced, mo.lateFees, mo.paid, mo.credit, mo.workTrade, mo.owed]))
    }
    lines.push(csvLine(['', 'Total', '', t.invoiced, t.lateFees, t.paid, t.credit, t.workTrade, t.owed]))
  }
  if (h.movedOutOwing.length) {
    lines.push('', csvLine(['Moved out, still owes']),
      csvLine(['Space', 'Tenant', 'Lease ended', 'Invoiced in range', 'Paid in range', 'Owed in range', 'Owed', 'Still owes for']))
    for (const m of h.movedOutOwing) {
      lines.push(csvLine([m.spaces.join(' '), names(m.residents), m.leaseEnded ?? '',
        m.inRange?.invoiced ?? 0, m.inRange?.paid ?? 0, m.inRange?.owed ?? 0, m.owed,
        m.months.map(x => `${monthTitle(x.month)} ${money(x.owed)}`).join('; ')]))
    }
  }
  return lines.join('\n') + '\n'
}

/** "rent-roll-oak-park-2026-07-to-2026-09.csv" */
export function csvFileName(h: Pick<RentRollHistory, 'propertyName' | 'from' | 'to' | 'allTime'>): string {
  const slug = h.propertyName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'property'
  const span = h.allTime ? 'all-time' : h.from === h.to ? h.from : `${h.from}-to-${h.to}`
  return `rent-roll-${slug}-${span}.csv`
}

/**
 * A household's name: opens its tenant report (that lease's household). 10/13
 * (Nic): a bookkeeper reads the Rent Roll read-only — the report is not theirs
 * (lib/bookkeeperAccess), so for them the name is just the name.
 */
function NameLink({ row }: { row: { householdId: string | null; leaseId: string | null; residents: RentRollResident[] } }) {
  const navigate = useNavigate()
  const role = useAuth()?.user?.role
  const to = role === 'bookkeeper' ? null : reportPath(row)
  const name = householdName(row.residents)
  const all = householdNames(row.residents)
  const others = row.residents.length > 1
    ? row.residents.filter(r => r.name !== name).map(r => r.name).filter(Boolean).join(', ') : ''
  return (
    <div style={{ minWidth: 0 }}>
      {to
        ? <button type="button" className="rr-name-link" title={`${all || name} — open the payment report`} onClick={() => navigate(to)}>{name}</button>
        : <span className="rr-name-link" style={{ cursor: 'default' }}>{name}</span>}
      {others && <span className="rr-sub" style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 190 }}>+ {others}</span>}
    </div>
  )
}

/** One month of one household: its colored stamp in words, the money on hover. */
function MonthStamp({ row, month }: { row: RentRollHistoryRow; month: string }) {
  const s = row.stamps.find(x => x.month === month)
  if (!s) return <StatusStamp status="none" label="No bill" color="gray" title={`${monthTitle(month)}: No bill`} />
  return <StatusStamp status={s.status} label={s.statusLabel} color={s.statusColor} title={monthStampTitle(s)} onboarding={s.onboarding} />
}

function Health({ row }: { row: RentRollHistoryRow }) {
  const h = row.health
  return (
    <span title={`Pays on time: ${h.label} — all time through ${monthTitle(h.through)}`}
      style={{ color: healthColor(h.percent), fontWeight: 700 }}>{healthText(h)}</span>
  )
}

const noRetryOn4xx = (count: number, e: any) => { const st = e?.response?.status; return !(st >= 400 && st < 500) && count < 2 }

export function RentRollPage() {
  const [params, setParams] = useSearchParams()
  const today = localToday()
  const props = useRentRollProperties()
  const list = props.data
  const propertyId = chosenProperty(params.get('property'), list)
  const property = list?.find(p => p.propertyId === propertyId) ?? null
  const many = (list?.length ?? 0) > 1
  // The view: the one the address names, else the default — the same for every property.
  const { pick: lit, range } = viewFromParams(params, today)
  const [movedOpen, setMovedOpen] = useState(false)

  const history = useQuery(['rent-roll-history', propertyId, rangeKey(range)],
    () => api.get(historyPath(propertyId!, range)).then(r => r.data.data as RentRollHistory), {
      enabled: !!propertyId, keepPreviousData: true, refetchOnWindowFocus: true, retry: noRetryOn4xx,
    })
  // Another property's figures never show under this one's name; this
  // property's last range stays up, dimmed, until the new one arrives (10/12).
  const data = history.data && history.data.propertyId === propertyId ? history.data : undefined
  const loadingOther = !!data && history.isPreviousData

  const setView = (v: RangePick | { from: string; to: string }) => setParams(withViewParams(params, v), { replace: true })
  const openProperty = (id: string) => {
    const next = new URLSearchParams(params)
    next.set('property', id)
    setParams(next)
    setMovedOpen(false)
  }
  const allProperties = () => {
    const next = new URLSearchParams(params)
    next.delete('property')
    setParams(next)
    setMovedOpen(false)
  }

  // The custom boxes show the range on screen (All time: once its months are known).
  const span = range.all ? (data?.allTime ? { from: data.from, to: data.to } : null) : range
  const choices = monthChoices(today, data?.from)
  const pickEdge = (edge: 'from' | 'to', month: string) => {
    if (!month) return
    setView(customRange(span ?? { from: month, to: month }, edge, month))
  }
  const exportCsv = () => { if (data) downloadText(csvFileName(data), rentRollCsv(data)) }

  const err = history.error as any
  const months = newestFirst(data?.months)
  const dim = { opacity: loadingOther ? 0.55 : 1, transition: 'opacity .15s' }

  return (
    <div>
      <div className="page-header">
        <div><h1 className="page-title">Rent Roll</h1></div>
      </div>

      {!propertyId ? (
        props.isLoading ? (
          <div className="card" style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
        ) : props.error ? (
          (props.error as any)?.response?.status === 403 ? (
            <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-2)' }}>
              The Rent Roll shows every household's payments. It needs the “View all payments” permission — ask the owner if you need it.
            </div>
          ) : (
            <div className="card" style={{ padding: 24, textAlign: 'center' }}>
              <p style={{ color: 'var(--text-2)', marginBottom: 10 }}>The properties could not be read.</p>
              <button className="btn btn-primary btn-sm" disabled={props.isFetching} onClick={() => props.refetch()}>{props.isFetching ? 'Reading…' : 'Read it again'}</button>
            </div>
          )
        ) : !list?.length ? (
          <div className="card"><div className="empty-state" style={{ padding: 48 }}><ScrollText size={40} /><h3>No properties yet</h3></div></div>
        ) : (
          <PropertyPickList properties={list} onPick={openProperty} />
        )
      ) : (
        <>
          <div className="rrh-head">
            {many && (
              <button type="button" className="btn btn-ghost btn-sm rr-noprint" onClick={allProperties}>
                <ArrowLeft size={14} /> All properties
              </button>
            )}
            <h2 className="rrh-head-name">{data?.propertyName ?? property?.name ?? ''}</h2>
            <div className="rrh-head-actions rr-noprint">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => window.print()} disabled={!data}><Printer size={13} /> Print</button>
              <button type="button" className="btn btn-primary btn-sm" onClick={exportCsv} disabled={!data}><Download size={13} /> Export CSV</button>
            </div>
          </div>

          <div className="rrh-view rr-noprint" role="group" aria-label="Months to show">
            {RANGE_PICKS.map(p => (
              <button key={p} type="button" className={`btn btn-sm ${lit === p ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={lit === p}
                onClick={() => setView(p)}>{RANGE_PICK_LABEL[p]}</button>
            ))}
            <span className="rrh-custom">
              <select className="form-select rrh-from" aria-label="From month" value={span?.from ?? ''} disabled={!span}
                onChange={e => pickEdge('from', e.target.value)}>
                {!span && <option value="">From</option>}
                {choices.map(m => <option key={m} value={m}>{monthTitle(m)}</option>)}
              </select>
              to
              <select className="form-select rrh-to" aria-label="To month" value={span?.to ?? ''} disabled={!span}
                onChange={e => pickEdge('to', e.target.value)}>
                {!span && <option value="">To</option>}
                {choices.map(m => <option key={m} value={m}>{monthTitle(m)}</option>)}
              </select>
            </span>
          </div>

          {history.error ? (
            err?.response?.status === 403 ? (
              <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-2)' }}>
                The Rent Roll shows every household's payments. It needs the “View all payments” permission — ask the owner if you need it.
              </div>
            ) : (
              <div className="card" style={{ padding: 24, textAlign: 'center' }}>
                <p style={{ color: 'var(--text-2)', marginBottom: 10 }}>
                  {err?.response?.status >= 400 && err?.response?.status < 500
                    ? (err?.response?.data?.error ?? 'The rent roll could not be read.')
                    : 'The rent roll could not be read.'}
                </p>
                {!(err?.response?.status >= 400 && err?.response?.status < 500) && (
                  <button className="btn btn-primary btn-sm" disabled={history.isFetching} onClick={() => history.refetch()}>{history.isFetching ? 'Reading…' : 'Read it again'}</button>
                )}
              </div>
            )
          ) : !data ? (
            <div className="card" style={{ padding: 32, color: 'var(--text-3)', textAlign: 'center' }}>Loading…</div>
          ) : (
            <>
              <div className="rrh-summary" style={dim} aria-busy={loadingOther || undefined}>
                <span className="rrh-range">{rangeTitle(data)}</span>
                {data.totals && (
                  <>
                    <span>Invoiced <strong>{money(data.totals.invoiced)}</strong></span>
                    <span>Paid <strong>{money(data.totals.paid)}</strong></span>
                    {data.totals.workTrade > 0 && <span>Work trade <strong>{money(data.totals.workTrade)}</strong></span>}
                    <span>Owed <strong className="owed">{money(data.totals.owed)}</strong></span>
                    {movedOutInRangeWords(data) && <span className="rrh-incl">{movedOutInRangeWords(data)}</span>}
                  </>
                )}
              </div>

              {data.rows.length === 0 ? (
                <div className="card" style={{ marginBottom: 14, ...dim }}>
                  <div className="empty-state" style={{ padding: 40 }}><ScrollText size={36} /><h3>Nobody was billed here in {rangeTitle(data)}</h3></div>
                </div>
              ) : (
                <div className="card rrh-card" style={dim} aria-busy={loadingOther || undefined}>
                  <div className="rr-split">
                    <div className="rr-fixed">
                      <table className="rr-table">
                        <thead><tr><th className="rrh-spacecol">Space</th><th>Tenant</th></tr></thead>
                        <tbody>
                          {data.rows.map(r => (
                            <tr key={r.key}>
                              <td className="rrh-spacecol">
                                {r.spaces.join(', ') || '—'}
                                {r.movedOut && <span className="rr-sub"><span className="rrh-moved">Moved out</span></span>}
                              </td>
                              <td><NameLink row={r} /></td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot><tr><td colSpan={2}>Households by month</td></tr></tfoot>
                      </table>
                    </div>
                    <div className="rr-scroll" tabIndex={0} role="region" aria-label={`${data.propertyName}, ${rangeTitle(data)}: each month, newest first`}>
                      <table className="rr-table">
                        <thead>
                          <tr>
                            <th className="num">Invoiced</th>
                            <th className="num">Paid</th>
                            <th className="num">Owed</th>
                            <th className="num" title="Pays on time, all time through the last month shown">Health</th>
                            {months.map(m => {
                              const yr = stripYear(m, data.to)
                              return (
                                <th key={m} className="rrh-stampcol" title={monthTitle(m)}>
                                  <span className="rrh-month-head">{shortMonth(m)}{yr && <span className="rrh-month-year">{yr}</span>}</span>
                                </th>
                              )
                            })}
                          </tr>
                        </thead>
                        <tbody>
                          {data.rows.map(r => (
                            <tr key={r.key}>
                              <td className="num">{money(r.invoiced)}{r.lateFees > 0 && <span className="rr-sub">incl. {money(r.lateFees)} late fees</span>}</td>
                              <td className="num">{money(r.paid)}{r.workTrade > 0 && <span className="rr-sub">+ {money(r.workTrade)} work trade</span>}</td>
                              <td className="num">{r.owed > 0 ? <span className="rr-owed">{money(r.owed)}</span> : <span className="rr-zero">{money(0)}</span>}</td>
                              <td className="num"><Health row={r} /></td>
                              {months.map(m => <td key={m} className="rrh-stampcol"><MonthStamp row={r} month={m} /></td>)}
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr>
                            <td colSpan={4} />
                            {months.map(m => (
                              <td key={m} className="rrh-stampcol">
                                {monthCountWords(data.monthCounts.find(c => c.month === m)).map(w => (
                                  <span key={w.status} className={`rrs-count ${w.color}`}>{w.text}</span>
                                ))}
                              </td>
                            ))}
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>

                  <div className="rr-cards">
                    {data.rows.map(r => (
                      <div key={r.key} className="rr-card">
                        <div className="rr-card-top">
                          <div style={{ minWidth: 0 }}>
                            <NameLink row={r} />
                            <span className="rr-space">{r.spaces.join(', ') || '—'}{r.movedOut ? ' · moved out' : ''}</span>
                          </div>
                          <div style={{ fontSize: '.74rem', color: 'var(--text-2)', whiteSpace: 'nowrap' }}>Health <Health row={r} /></div>
                        </div>
                        <div className="rr-card-figs">
                          <div>Invoiced<strong>{money(r.invoiced)}</strong></div>
                          <div>Paid<strong>{money(r.paid)}</strong></div>
                          <div>Owed<strong>{money(r.owed)}</strong></div>
                        </div>
                        <div className="rr-card-stamps" tabIndex={0} role="region" aria-label={`${householdName(r.residents)}: each month, newest first`}>
                          {months.map(m => (
                            <div key={m} className="rr-card-stamp">
                              <MonthStamp row={r} month={m} />
                              <span className="rr-stamp-month">{shortMonth(m)}{stripYear(m, data.to) ?? ''}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {data.movedOutOwing.length > 0 && (
                <div className="card rrh-folder">
                  <button type="button" className="rrh-folder-head" aria-expanded={movedOpen} onClick={() => setMovedOpen(o => !o)}>
                    {movedOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                    Moved out, still owes
                    <span className="rrh-folder-meta">{data.movedOutOwing.length} household{data.movedOutOwing.length === 1 ? '' : 's'}</span>
                  </button>
                  {movedOpen && (
                    <div className="rrh-folder-body">
                      <table className="rrh-mo-table">
                        <thead><tr><th>Space</th><th>Tenant</th><th>Lease ended</th><th>Still owes for</th><th className="num">Owed</th></tr></thead>
                        <tbody>
                          {data.movedOutOwing.map(m => (
                            <tr key={m.key}>
                              <td>{m.spaces.join(', ') || '—'}</td>
                              <td><NameLink row={m} /></td>
                              <td>{m.leaseEnded ? dayWord(m.leaseEnded, '') : '—'}</td>
                              <td className="wrap">{m.months.map(x => `${shortMonth(x.month)} ${x.month.slice(0, 4)} ${money(x.owed)}`).join(' · ')}</td>
                              <td className="num"><span className="rr-owed">{money(m.owed)}</span></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}
