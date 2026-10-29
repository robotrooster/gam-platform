/**
 * S652 — ONE WORK-TRADE WINDOW, TWO PORTALS.
 *
 * Nic: "this is the same window that I want the tenants to see. Their
 * agreement, their jobs, all this stuff... The landlord and the tenant should
 * be seeing the same screens, but from their different portals."
 *
 * So there is exactly one component, imported by both apps. `side` only adds
 * the landlord's controls (approve / deny, trusted, skills, duties, end); the
 * tenant sees every figure the landlord sees except the dollar value of a
 * shortfall, which the server already withholds from the tenant (S643).
 *
 * Words (Nic): hours turned in and not yet reviewed are "Logged" — never
 * "pending", which read as already in trouble. Approved and Denied are the only
 * final states. Only approved hours reduce the bill; hours still logged when the
 * month closes count as not worked.
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from 'react-query'
import { X, Check, Clock, ShieldCheck, Eye, Wrench, Gauge } from 'lucide-react'
import {
  WORK_TRADE_SKILLS, WORK_TRADE_SKILL_LABEL, WORK_TRADE_LOG_STATUS_LABEL,
  WORK_TRADE_COVERABLE_LABEL, WORK_TRADE_FIELD_PERMISSIONS, WORK_TRADE_FIELD_PERMISSION_LABEL,
} from '@gam/shared'
import { ReadingWalkModal } from './MeterWalk'
import { ExtraHoursSetting, ExtraHoursPayables, ExtraHoursRecord } from './WorkTradeExtraHours'

export type PanelApi = {
  get: (url: string) => Promise<any>
  post: (url: string, body?: any) => Promise<any>
  patch: (url: string, body?: any) => Promise<any>
}

/**
 * 10/19 (Nic) — THE PAUSE QUESTION, IN WORDS ABOUT A CAMPER.
 *
 * "The landlord needs to have a way to set whether they occupy the spot or not.
 * Because if somebody wants to work more hours in the winter but leave their
 * camper occupying the space in the summer, that's one situation. If people take
 * their camper home for the summer with them and it's not occupying the spot,
 * then there would be no reason for it to continue to track hours."
 *
 * Worded for a mobile home and an apartment too — a trade is not always an RV
 * spot — so it asks whether the SPACE is still being used rather than naming a
 * camper, and the help text gives the camper as the example it came from.
 */
const SPACE_IN_USE = 'Still being used'
const SPACE_EMPTY = 'The space is empty'
/** What each answer actually does, said once. */
const SPACE_ANSWER_MEANS = {
  used: 'Hours keep counting, and the months already billed under the trade work exactly as they normally do.',
  empty: 'No hours are counted while this is paused, and the months already billed under the trade are covered at the next month close.',
}
/**
 * 10/19 (review) — AND THE ONE THING NEITHER ANSWER DOES.
 *
 * These two sentences used to promise that a paused trade's charges "are not
 * billed" and that its month "works exactly as it normally does". Both are true
 * of the months ALREADY BILLED under the trade — their settlement periods are
 * open and the month close reads the live answer. Neither is true of a month
 * billed DURING the pause: the billing run only covers a RUNNING agreement
 * (services/workTradeCredit loadWorkTradeCreditContext), so while a trade is
 * paused the new month opens no period, nothing is suspended, and the bill goes
 * out at its full amount — and no hour worked that month can credit it either.
 *
 * Pausing by hand is what made that reachable: until the button below existed, a
 * pause only came from lease hibernation or a lease expiring, and neither bills
 * anything. Whether a paused month SHOULD be covered is a money decision and
 * Nic's to make. Until he answers, the landlord doing the pausing reads what
 * actually happens instead of a promise the billing run does not keep.
 */
/*
  Phrased CONDITIONALLY — "a bill that goes out", not "a bill goes out" —
  because a pause does not always mean a bill. Both work trades paused at
  Mountain View today sit on HIBERNATING leases, and a hibernating lease bills
  nothing at all (jobs/invoiceGeneration gates on is_hibernating), so promising
  a full bill there would be its own false sentence in the other direction.
  Same wording as the server's (services/workTradeStanding PAUSED_NEW_BILLS).
*/
const PAUSED_NEW_BILLS = 'A bill that goes out while it stays paused is not covered by the trade — it is owed in full, like any other bill.'

const card: React.CSSProperties = { padding: 14, marginBottom: 12 }
const label: React.CSSProperties = { fontSize: '.64rem', fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', color: 'var(--text-3)', marginBottom: 6 }
const fmtH = (n: any) => `${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} hrs`
const fmtDate = (d: string | null | undefined) => d ? new Date(d.length === 10 ? d + 'T12:00:00' : d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

function Figure({ name, value, accent }: { name: string; value: string; accent?: boolean }) {
  return (
    <div style={{ flex: '1 1 110px', minWidth: 0 }}>
      <div style={label}>{name}</div>
      <div style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '1rem', color: accent ? 'var(--gold)' : 'var(--text-0)' }}>{value}</div>
    </div>
  )
}

export function WorkTradePanel({ agreementId, side, api, onClose, notify }: {
  agreementId: string
  side: 'landlord' | 'tenant'
  api: PanelApi
  onClose?: () => void
  notify?: (msg: string, kind?: 'error') => void
}) {
  const qc = useQueryClient()
  const key = ['wt-panel', agreementId]
  const { data, isLoading } = useQuery<any>(key, () => api.get(`/work-trade/${agreementId}`))
  const { data: standing } = useQuery<any>(['wt-standing', agreementId],
    () => api.get(`/work-trade/${agreementId}/standing`).catch(() => null))
  const isLandlord = side === 'landlord'
  // 10/12: paid extra hours owed for this agreement, with both ways to pay them.
  const { data: payables = [] } = useQuery<any[]>(['wt-extra-hours', agreementId],
    () => api.get(`/work-trade/${agreementId}/extra-hours`), { enabled: isLandlord })
  const refresh = () => {
    qc.invalidateQueries(key); qc.invalidateQueries(['wt-standing', agreementId]); qc.invalidateQueries('work-trade')
    qc.invalidateQueries(['wt-extra-hours', agreementId]); qc.invalidateQueries('wt-extra-hours-open')
  }
  const say = (m: string, kind?: 'error') => notify?.(m, kind)
  const a = data?.agreement
  const logs: any[] = data?.logs ?? []
  const stats = data?.stats
  const record = data?.record

  const [duties, setDuties] = useState<string | null>(null)
  const [denying, setDenying] = useState<{ id: string; reason: string } | null>(null)
  const [logging, setLogging] = useState(false)
  const [form, setForm] = useState({ workDate: new Date().toISOString().slice(0, 10), hours: '', description: '' })
  const [ending, setEnding] = useState(false)
  // 10/19: the landlord is pausing, and has not answered the space question yet.
  const [pausing, setPausing] = useState(false)
  const [finishing, setFinishing] = useState<{ id: string; hours: string; note: string } | null>(null)
  // S652 (Nic): "Curtis needs to be able to do and initiate the meter reading."
  // The same walk the front desk takes, from the tenant portal, when the
  // landlord ticked Read meters on this agreement.
  const [walkRun, setWalkRun] = useState<any | null>(null)
  const propertyIdForRuns = side === 'tenant' && data?.agreement?.fieldPermissions?.includes('read_meters') ? data.agreement.propertyId : null
  const { data: runs = [] } = useQuery<any[]>(['wt-reading-runs', propertyIdForRuns],
    () => api.get(`/utility/reading-runs?propertyId=${propertyIdForRuns}`),
    { enabled: !!propertyIdForRuns })
  const openRun = (runs as any[]).find(r => r.status === 'open' || r.status === 'double_check')
  const startRun = useMutation(() => api.post('/utility/reading-runs', { propertyId: propertyIdForRuns }),
    { onSuccess: () => qc.invalidateQueries(['wt-reading-runs', propertyIdForRuns]),
      onError: (e: any) => say(e?.message || 'Could not start the reading', 'error') })

  // S652: the tenant's live job list (theirs, open ones, ones to confirm) —
  // their own endpoint, because what they may see depends on who they are.
  const { data: myJobs } = useQuery<any>(['wt-jobs'], () => api.get('/work-trade/jobs'),
    { enabled: side === 'tenant' })
  const refreshJobs = () => { qc.invalidateQueries(['wt-jobs']); refresh() }
  const jobAct = useMutation(({ id, act, body }: any) => api.post(`/work-trade/jobs/${id}/${act}`, body ?? {}),
    { onSuccess: (_r: any, v: any) => { refreshJobs(); setFinishing(null)
        say(v.act === 'take' ? 'Job taken' : v.act === 'done' ? 'Marked done' : 'Confirmed') },
      onError: (e: any) => say(e?.message || 'Could not do that', 'error') })

  // 10/19 (review): a REFUSED save re-reads the agreement too. This window's
  // controls are drawn from the row it fetched, so a trade resumed elsewhere (a
  // lease woken in another tab) leaves the pause's "The space is empty" button
  // on screen for a trade that is running again. The server refuses the answer
  // in that state; re-reading here takes the stale control away instead of
  // leaving it there to be clicked again.
  const patch = useMutation((body: any) => api.patch(`/work-trade/${agreementId}`, body),
    { onSuccess: () => { refresh(); setDuties(null) },
      onError: (e: any) => { refresh(); say(e?.message || 'Could not save that', 'error') } })
  const review = useMutation(({ id, action, reason }: any) => api.patch(`/work-trade/logs/${id}`, { action, rejectionReason: reason }),
    { onSuccess: () => { refresh(); setDenying(null) }, onError: (e: any) => say(e?.message || 'Could not save that', 'error') })
  const logHours = useMutation(() => api.post(`/work-trade/${agreementId}/logs`, {
      workDate: form.workDate, hours: Number(form.hours), description: form.description.trim() }),
    { onSuccess: () => { refresh(); setLogging(false); setForm({ workDate: new Date().toISOString().slice(0, 10), hours: '', description: '' }); say('Hours logged') },
      onError: (e: any) => say(e?.message || 'Could not log those hours', 'error') })

  if (isLoading || !a) return <div className="card" style={{ ...card, color: 'var(--text-3)' }}>Loading…</div>

  const asleep = a.status === 'paused'
  const statusText = a.status === 'active' ? 'Active' : asleep ? 'Asleep for the season' : 'Ended'
  const tracks = a.tracksHours !== false
  // 10/19 (Nic): while this is paused, is the space still being used? undefined
  // or null means nobody has been asked — two paths pause an agreement with no
  // landlord in front of a screen (lease hibernation, and a lease expiring with
  // no successor), and unanswered keeps counting hours, which is what a paused
  // agreement has always done.
  const spaceOccupied: boolean | null = a.pausedSpaceOccupied ?? null
  const spaceEmpty = asleep && spaceOccupied === false
  // The one fact the screen hangs off: are hours being counted right now? Two
  // switches can turn it off, and the server answers the same question the same
  // way (services/workTradeStanding hoursCountedSql) so neither side of the
  // trade can be shown a target the month close is about to waive.
  const counting = tracks && !spaceEmpty
  const loggedHours = logs.filter(l => l.status === 'pending').reduce((s, l) => s + Number(l.hours), 0)
  const covers: string[] = a.coveredCharges?.length ? a.coveredCharges : Object.keys(WORK_TRADE_COVERABLE_LABEL)
  const skills: string[] = a.skills ?? []
  const fieldPerms: string[] = a.fieldPermissions ?? []
  // 10/19: hours can only be turned in against a month somebody is counting.
  // Said as `counting` rather than `tracks` because that is the actual rule —
  // and the server holds the same line (routes/workTrade POST /:id/logs refuses
  // an agreement that is not active), so the button and the route agree.
  const canLog = a.status === 'active' && counting
  /*
    10/19 (review) — SAY WHAT THE ANSWER WAIVES BEFORE IT IS GIVEN, ON BOTH CARDS.
    Stopping the count covers every month still OPEN outright, not just this one:
    loadOpenPeriods applies the live answer to each open period, so August's and
    September's targets read 0 too and periodCredit covers them. That clears a
    catch-up the landlord is owed, and it is effectively irreversible — the next
    close settles those periods, and loadOpenPeriods only ever reopens `open`
    ones. It was priced on the already-paused card and not on the pause-now one,
    which is the card where the answer is given for the first time. Written once
    here so the two cannot drift again.
  */
  const carriedWaiverNote = Number(standing?.carriedHours ?? 0) > 0 ? (
    <div style={{ fontSize: '.74rem', color: 'var(--text-2)', marginTop: 6, lineHeight: 1.5 }}>
      They are {fmtH(standing?.carriedHours)} behind from earlier months
      {standing?.carriedValue != null && Number(standing.carriedValue) > 0
        ? `, worth $${Number(standing.carriedValue).toFixed(2)}` : ''}.
      Saying the space is empty covers those months too, and that catch-up is cleared.
    </div>
  ) : null
  const readsMeters = side === 'tenant' && a.status === 'active' && fieldPerms.includes('read_meters') && !!a.propertyId

  return (
    <div>
      {/* ── who, where, and how it stands ── */}
      <div className="card" style={card}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: '1.02rem', color: 'var(--text-0)' }}>
              {[a.tenantFirst, a.tenantLast].filter(Boolean).join(' ') || 'Work trade agreement'}
            </div>
            <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>Unit {a.unitNumber} · {a.propertyName}</div>
          </div>
          <span className="badge" style={{ fontSize: '.66rem' }}>{statusText}</span>
          <span className="badge" style={{ fontSize: '.66rem', color: a.trusted ? 'var(--gold)' : undefined }}>
            {a.trusted ? <><ShieldCheck size={11} style={{ verticalAlign: '-1px' }} /> Trusted</> : <><Eye size={11} style={{ verticalAlign: '-1px' }} /> Monitored</>}
          </span>
          {onClose && <button className="btn btn-ghost btn-sm" onClick={onClose} title="Close"><X size={14} /></button>}
        </div>
        {/*
          10/19 — THIS USED TO SAY THE SAME THING WHATEVER WAS TRUE.
          "Their spot is hibernating, so nothing is owed and nothing is billed
          until they are back" was shown on every paused agreement, including one
          that counts hours — whose month still closes and still leaves the
          unworked part owed on its own bill (jobs/workTradeSettlement
          CLOSE_STATUSES). A tenant read "nothing is owed" and then got a bill.
          So the banner now says which of Nic's two situations this is.
        */}
        {asleep && (
          <div style={{ marginTop: 8, fontSize: '.78rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
            {!tracks
              ? (isLandlord
                ? 'Paused. No hours are counted on this agreement either way, so the months already billed under it are covered at the next month close.'
                : 'Your work trade is paused. No hours are counted on it either way, so the months already billed under it are covered at the next month close.')
              : spaceEmpty
                ? (isLandlord
                  ? 'Paused, and the space is empty — no hours are being counted, and the months already billed under this trade are covered at the next month close.'
                  : 'Your work trade is paused and your space is empty, so no hours are being counted. The months already billed under it are covered at the next month close.')
                : spaceOccupied === true
                  ? (isLandlord
                    ? 'Paused, and the space is still being used — hours keep counting and the months already billed under it work exactly as they normally do.'
                    : 'Your work trade is paused, but your space is still being used, so your hours keep counting and the months already billed under it work as they normally do.')
                  : (isLandlord
                    ? 'Paused. Hours are still counting, because nobody has said yet whether the space is still being used — answer that below.'
                    : 'Your work trade is paused, and your hours are still counting for now. Your landlord has not said yet whether your space counts as still being used.')}
            {/*
              10/19 (review): and the part no answer changes — a month billed
              while this stays paused is not covered by the trade at all. Said to
              both sides, because the tenant is the one who gets that bill.

              NOT on a trade that lease hibernation paused: their spot is asleep
              and nothing bills on it at all (jobs/invoiceGeneration gates on
              is_hibernating), so a sentence about an uncovered bill would be the
              same mistake pointing the other way. Both paused trades at
              Mountain View today are exactly this.
            */}
            {a.pausedByHibernation !== true && <>{' '}{PAUSED_NEW_BILLS}</>}
          </div>
        )}
      </div>

      {/* ── this month ── */}
      {/*
        10/19: gated on `counting`, not on `tracks`. A paused trade on an empty
        space asks for no hours, and showing "0 of 80 hrs" and "Bill covered 0%"
        to somebody who is six states away for the summer is a target they are
        failing at a job nobody asked them to do.
      */}
      {counting ? (
        <div className="card" style={card}>
          <div style={label}>This month</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
            <Figure name="Approved" value={`${fmtH(stats?.hoursApprovedThisMonth)} of ${fmtH(stats?.target)}`} accent />
            <Figure name="Logged, not yet reviewed" value={fmtH(loggedHours)} />
            {standing && <Figure name="Carried over" value={fmtH(standing.carriedHours)} />}
            {standing && <Figure name="To get straight" value={fmtH(standing.catchUpHours)} />}
            <Figure name="Bill covered" value={`${stats?.creditPct ?? 0}%`} />
          </div>
          <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginTop: 10, lineHeight: 1.5 }}>
            Hours are reviewed by <b style={{ color: 'var(--text-1)' }}>{fmtDate(stats?.reviewBy)}</b>, the last business day of the month.
            Only approved hours count toward the bill; hours still logged then count as not worked.
            {a.trusted ? ' Trusted: hours count as soon as they are logged.' : ''}
          </div>
          {isLandlord && standing?.carriedValue != null && Number(standing.carriedValue) > 0 && (
            <div style={{ fontSize: '.74rem', color: 'var(--text-2)', marginTop: 6 }}>
              Carried hours would bill ${Number(standing.carriedValue).toFixed(2)} if the agreement ended today.</div>
          )}
        </div>
      ) : (
        <div className="card" style={{ ...card, fontSize: '.82rem', color: 'var(--text-2)' }}>
          {tracks
            ? 'No hours are being counted while this is paused and the space is empty. There is no target to meet, and nothing falls behind.'
            : 'No hours are tracked on this agreement. The charges it covers are simply not billed.'}
        </div>
      )}

      {/* ── 10/12: extra hours — beyond what the trade needs ── */}
      {/* 10/19: nothing can be "beyond what the trade needs" while it needs nothing. */}
      {counting && (isLandlord ? (
        <div className="card" style={card}>
          <ExtraHoursSetting key={`${a.extraHoursMode}-${a.extraHoursRate}-${a.extraHoursPayMethod}`}
            agreement={a} api={api} onSaved={refresh} notify={say} />
          {(payables as any[]).length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={label}>Paid extra hours</div>
              <ExtraHoursPayables rows={payables as any[]} api={api} onChanged={refresh} notify={say} />
            </div>
          )}
          {standing?.extraHours?.recent?.some((e: any) => e.how === 'banked') && (
            <div style={{ marginTop: 14 }}>
              <div style={label}>Extra hours banked</div>
              <ExtraHoursRecord extra={standing.extraHours} side="landlord" only="banked" />
            </div>
          )}
        </div>
      ) : (
        <div className="card" style={card}>
          <div style={label}>Extra hours</div>
          <div style={{ fontSize: '.78rem', color: 'var(--text-2)', marginBottom: standing?.extraHours?.recent?.length ? 6 : 0 }}>
            {standing?.extraHours?.mode === 'pay'
              ? 'Hours you work beyond what your agreement needs are paid separately by your landlord.'
              : 'Hours you work beyond what your agreement needs are banked toward future months.'}
          </div>
          <ExtraHoursRecord extra={standing?.extraHours} side="tenant" />
        </div>
      ))}

      {/* ── what they do ── */}
      <div className="card" style={card}>
        <div style={label}>Duties</div>
        {isLandlord && duties !== null ? (
          <>
            <textarea className="input" rows={4} style={{ width: '100%', resize: 'vertical' }} value={duties} onChange={e => setDuties(e.target.value)} />
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button className="btn btn-primary btn-sm" disabled={patch.isLoading} onClick={() => patch.mutate({ duties: duties.trim() || null })}>Save</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setDuties(null)}>Cancel</button>
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, fontSize: '.84rem', color: a.duties ? 'var(--text-1)' : 'var(--text-3)', whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>
              {a.duties || 'No duties written down yet.'}</div>
            {isLandlord && <button className="btn btn-primary btn-sm" onClick={() => setDuties(a.duties ?? '')}>Edit</button>}
          </div>
        )}

        <div style={{ ...label, marginTop: 14 }}>Skilled work they take on</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {(isLandlord ? WORK_TRADE_SKILLS : skills).map((s: any) => {
            const on = skills.includes(s)
            return isLandlord ? (
              <button key={s} className={`btn btn-sm ${on ? 'btn-primary' : 'btn-ghost'}`} disabled={patch.isLoading}
                onClick={() => patch.mutate({ skills: on ? skills.filter(x => x !== s) : [...skills, s] })}>
                {on && <Check size={11} />} {(WORK_TRADE_SKILL_LABEL as any)[s]}
              </button>
            ) : <span key={s} className="badge">{(WORK_TRADE_SKILL_LABEL as any)[s]}</span>
          })}
          {!isLandlord && skills.length === 0 && <span style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>General work: grounds, cleaning, and odd jobs.</span>}
        </div>

        <div style={{ ...label, marginTop: 14 }}>Field work they may do from their portal</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {(isLandlord ? WORK_TRADE_FIELD_PERMISSIONS : fieldPerms).map((f: any) => {
            const on = fieldPerms.includes(f)
            return isLandlord ? (
              <button key={f} className={`btn btn-sm ${on ? 'btn-primary' : 'btn-ghost'}`} disabled={patch.isLoading}
                onClick={() => patch.mutate({ fieldPermissions: on ? fieldPerms.filter(x => x !== f) : [...fieldPerms, f] })}>
                {on && <Check size={11} />} {(WORK_TRADE_FIELD_PERMISSION_LABEL as any)[f]}
              </button>
            ) : <span key={f} className="badge">{(WORK_TRADE_FIELD_PERMISSION_LABEL as any)[f]}</span>
          })}
          {!isLandlord && fieldPerms.length === 0 && <span style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>None.</span>}
        </div>

        <div style={{ ...label, marginTop: 14 }}>Covers</div>
        <div style={{ fontSize: '.82rem', color: 'var(--text-1)' }}>
          {covers.map(c => (WORK_TRADE_COVERABLE_LABEL as any)[c] ?? c).join(', ')}</div>

        {isLandlord && (
          <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={label}>Trust</div>
            <button className={`btn btn-sm ${a.trusted ? 'btn-primary' : 'btn-ghost'}`} disabled={patch.isLoading} onClick={() => !a.trusted && patch.mutate({ trusted: true })}>Trusted</button>
            <button className={`btn btn-sm ${!a.trusted ? 'btn-primary' : 'btn-ghost'}`} disabled={patch.isLoading} onClick={() => a.trusted && patch.mutate({ trusted: false })}>Monitored</button>
            <span style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
              {a.trusted ? 'Their hours count when logged, and they can confirm finished jobs.' : 'Their hours wait for your review.'}</span>
          </div>
        )}
      </div>

      {/* ── meter readings (tenant with Read meters) ── */}
      {readsMeters && (
        <div className="card" style={card}>
          <div style={label}><Gauge size={11} style={{ verticalAlign: '-1px' }} /> Meter readings</div>
          {openRun ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200, fontSize: '.82rem', color: 'var(--text-1)' }}>
                <b>{openRun.status === 'double_check' ? 'All meters read' : 'Readings due'}</b>
                <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginTop: 2 }}>
                  {openRun.status === 'double_check'
                    ? 'A few readings are with the landlord to double-check. Nothing more to read.'
                    : `${openRun.metersRead ?? 0} of ${openRun.metersTotal ?? 0} meters read.`}
                </div>
              </div>
              {openRun.status !== 'double_check' && (
                <button className="btn btn-primary btn-sm" onClick={() => setWalkRun(openRun)}>
                  {openRun.metersRead > 0 ? 'Continue reading' : 'Start reading'}
                </button>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ flex: 1, minWidth: 200, fontSize: '.8rem', color: 'var(--text-2)' }}>
                No readings due right now. The month's run opens on the last business day.</span>
              <button className="btn btn-primary btn-sm" disabled={startRun.isLoading} onClick={() => startRun.mutate()}>Start early</button>
            </div>
          )}
        </div>
      )}
      {walkRun && (
        <ReadingWalkModal run={walkRun} api={api}
          onClose={() => { setWalkRun(null); qc.invalidateQueries(['wt-reading-runs', propertyIdForRuns]) }} />
      )}

      {/* ── jobs ── */}
      <div className="card" style={card}>
        <div style={label}><Wrench size={11} style={{ verticalAlign: '-1px' }} /> Jobs</div>
        {/*
          10/19 (Nic, "Show it while paused"): their tab stays up while the
          trade is paused, so this board has to say why it is empty. The jobs
          endpoint only serves a running agreement (services/workTradeJobs), so
          without this a tenant away for the season read "Nothing open right
          now" and an invitation to take a job that would be refused.
        */}
        {side === 'tenant' ? (asleep ? (
          <div style={{ fontSize: '.8rem', color: 'var(--text-2)', lineHeight: 1.5 }}>
            Jobs are paused along with your agreement — there is nothing to take or turn in while it is paused.
          </div>
        ) : (
          <>
            {[['Yours', myJobs?.mine ?? [], 'mine'], ['Open — take one', myJobs?.available ?? [], 'open'],
              ...(a.trusted ? [['Finished work to confirm', myJobs?.toCheck ?? [], 'check']] : [])].map(([title, list, kind]: any) => (
              <div key={kind} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: '.74rem', fontWeight: 700, color: 'var(--text-2)', margin: '4px 0' }}>{title}</div>
                {list.length === 0 && <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
                  {kind === 'open' ? 'Nothing open right now.' : kind === 'mine' ? 'None taken.' : 'Nothing waiting.'}</div>}
                {list.map((j: any) => (
                  <div key={j.id} style={{ padding: '8px 0', borderTop: '1px solid var(--border-0, var(--b1))' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: '.84rem', color: 'var(--text-0)' }}>{j.title}
                          {j.priority === 'emergency' || j.priority === 'high' ? <span className="badge" style={{ marginLeft: 6, fontSize: '.6rem', color: 'var(--red, #dc4c4c)' }}>{j.priority === 'emergency' ? 'Emergency' : 'High'}</span> : null}</div>
                        <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>Unit {j.unitNumber} · {j.propertyName}</div>
                        {j.description && <div style={{ fontSize: '.78rem', color: 'var(--text-1)', marginTop: 3, whiteSpace: 'pre-wrap' }}>{j.description}</div>}
                        {j.notes && <div style={{ fontSize: '.74rem', color: 'var(--text-2)', marginTop: 3 }}>Notes: {j.notes}</div>}
                      </div>
                      {kind === 'open' && <button className="btn btn-primary btn-sm" disabled={jobAct.isLoading} onClick={() => jobAct.mutate({ id: j.id, act: 'take' })}>Take it</button>}
                      {kind === 'mine' && finishing?.id !== j.id && <button className="btn btn-primary btn-sm" onClick={() => setFinishing({ id: j.id, hours: '', note: '' })}>Mark done</button>}
                      {kind === 'check' && <button className="btn btn-primary btn-sm" disabled={jobAct.isLoading} onClick={() => jobAct.mutate({ id: j.id, act: 'check' })}>Confirm</button>}
                    </div>
                    {finishing && finishing.id === j.id && (
                      <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 6, marginTop: 6 }}>
                        <input className="input" type="number" step="0.25" min="0" placeholder="Hours" value={finishing.hours} onChange={e => setFinishing({ ...finishing, hours: e.target.value })} />
                        <input className="input" placeholder="What you did (optional)" value={finishing.note} onChange={e => setFinishing({ ...finishing, note: e.target.value })} />
                        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 6 }}>
                          <button className="btn btn-primary btn-sm" disabled={jobAct.isLoading} onClick={() => jobAct.mutate({ id: j.id, act: 'done',
                            body: { hours: Number(finishing.hours) > 0 ? Number(finishing.hours) : undefined, note: finishing.note.trim() || undefined } })}>Done</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setFinishing(null)}>Cancel</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </>
        )) : (
          <>
            {(data?.jobs ?? []).length === 0 && <div style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>No jobs taken or finished lately.</div>}
            {(data?.jobs ?? []).map((j: any) => (
              <div key={j.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 0', borderTop: '1px solid var(--border-0, var(--b1))' }}>
                <div style={{ flex: 1, minWidth: 0, fontSize: '.82rem', color: 'var(--text-1)' }}>{j.title}
                  <span style={{ color: 'var(--text-3)', fontSize: '.72rem' }}> · Unit {j.unitNumber}</span></div>
                <span className="badge" style={{ fontSize: '.64rem' }}>
                  {j.status === 'completed' ? (j.needsCheck ? 'Done, needs a check' : 'Done') : 'In progress'}</span>
                {j.status === 'completed' && j.needsCheck && (
                  <button className="btn btn-primary btn-sm" disabled={jobAct.isLoading} onClick={() => jobAct.mutate({ id: j.id, act: 'check' })}>Confirm</button>)}
              </div>
            ))}
          </>
        )}
      </div>

      {/* ── their record ── */}
      {tracks && record && record.submitted > 0 && (
        <div className="card" style={card}>
          <div style={label}>Record</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
            <Figure name="Times turned in" value={String(record.submitted)} />
            <Figure name="Approved" value={record.approvedPct == null ? '—' : `${record.approved} (${record.approvedPct}%)`} />
            <Figure name="Denied" value={record.deniedPct == null ? '—' : `${record.denied} (${record.deniedPct}%)`} accent={Number(record.deniedPct) >= 33} />
            <Figure name="Hours denied" value={record.hoursDeniedPct == null ? '—' : `${fmtH(record.hoursDenied)} (${record.hoursDeniedPct}%)`} />
          </div>
        </div>
      )}

      {/* ── hours ── */}
      {tracks && (
        <div className="card" style={card}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ ...label, marginBottom: 0, flex: 1 }}>Hours</div>
            {canLog && !logging && <button className="btn btn-primary btn-sm" onClick={() => setLogging(true)}><Clock size={12} /> Log hours</button>}
          </div>
          {logging && (
            <div style={{ display: 'grid', gridTemplateColumns: '140px 90px 1fr', gap: 8, marginBottom: 10 }}>
              <input className="input" type="date" value={form.workDate} onChange={e => setForm(f => ({ ...f, workDate: e.target.value }))} />
              <input className="input" type="number" step="0.25" min="0.25" placeholder="Hours" value={form.hours} onChange={e => setForm(f => ({ ...f, hours: e.target.value }))} />
              <input className="input" placeholder="What was done" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
              <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 6 }}>
                <button className="btn btn-primary btn-sm" disabled={logHours.isLoading || !(Number(form.hours) > 0) || form.description.trim().length < 3} onClick={() => logHours.mutate()}>Save</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setLogging(false)}>Cancel</button>
              </div>
            </div>
          )}
          {logs.length === 0 && <div style={{ fontSize: '.8rem', color: 'var(--text-3)' }}>No hours turned in yet.</div>}
          {logs.map(l => (
            <div key={l.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 0', borderTop: '1px solid var(--border-0, var(--b1))' }}>
              <div style={{ width: 92, fontSize: '.76rem', color: 'var(--text-2)', flexShrink: 0 }}>{fmtDate(l.workDate)}</div>
              <div style={{ width: 62, fontFamily: 'monospace', fontWeight: 700, fontSize: '.82rem', color: 'var(--text-0)', flexShrink: 0 }}>{Number(l.hours)} h</div>
              <div style={{ flex: 1, minWidth: 0, fontSize: '.8rem', color: 'var(--text-1)' }}>
                {l.description}
                {l.status === 'rejected' && l.rejectionReason && <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginTop: 2 }}>Denied: {l.rejectionReason}</div>}
                {denying && denying.id === l.id && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <input className="input" style={{ flex: 1 }} placeholder="Why (they will see this)" value={denying.reason} onChange={e => setDenying({ id: l.id, reason: e.target.value })} />
                    <button className="btn btn-primary btn-sm" disabled={review.isLoading} onClick={() => review.mutate({ id: l.id, action: 'reject', reason: denying.reason.trim() || undefined })}>Deny</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setDenying(null)}>Cancel</button>
                  </div>
                )}
              </div>
              <span className="badge" style={{ fontSize: '.64rem', flexShrink: 0,
                color: l.status === 'approved' ? 'var(--green, #3fb97f)' : l.status === 'rejected' ? 'var(--red, #dc4c4c)' : 'var(--text-2)' }}>
                {WORK_TRADE_LOG_STATUS_LABEL[l.status] ?? l.status}</span>
              {isLandlord && denying?.id !== l.id && (
                <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  {l.status !== 'approved' && <button className="btn btn-primary btn-sm" disabled={review.isLoading} onClick={() => review.mutate({ id: l.id, action: 'approve' })}>Approve</button>}
                  {l.status !== 'rejected' && <button className="btn btn-primary btn-sm" onClick={() => setDenying({ id: l.id, reason: '' })}>Deny</button>}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── 10/19: while this is paused, is the space still being used? ── */}
      {/*
        Nic: "which needs to be an individual landlord decision. We're going for
        flexibility and transparency and honesty on both sides."
        Changeable while it stays paused, because a camper can leave later — the
        close and the standing both read the live answer, so a change takes
        effect from the next month close on.
      */}
      {isLandlord && asleep && tracks && (
        <div className="card" style={card}>
          <div style={label}>While this is paused</div>
          <div style={{ fontSize: '.84rem', color: 'var(--text-1)', marginBottom: 4 }}>
            Is the space still being used?
          </div>
          <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginBottom: 8, lineHeight: 1.5 }}>
            A camper left parked on the spot over the summer is still using it. One taken home for the season is not.
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button className={`btn btn-sm ${spaceOccupied === true ? 'btn-primary' : 'btn-ghost'}`}
              disabled={patch.isLoading}
              onClick={() => spaceOccupied !== true && patch.mutate({ spaceOccupiedWhilePaused: true })}>
              {spaceOccupied === true && <Check size={11} />} {SPACE_IN_USE}
            </button>
            <button className={`btn btn-sm ${spaceOccupied === false ? 'btn-primary' : 'btn-ghost'}`}
              disabled={patch.isLoading}
              onClick={() => spaceOccupied !== false && patch.mutate({ spaceOccupiedWhilePaused: false })}>
              {spaceOccupied === false && <Check size={11} />} {SPACE_EMPTY}
            </button>
          </div>
          <div style={{ fontSize: '.74rem', color: 'var(--text-2)', marginTop: 8, lineHeight: 1.5 }}>
            {spaceOccupied === null
              ? `Nobody has answered yet, so hours are still counting — that is what a paused trade has always done. ${SPACE_ANSWER_MEANS.used}`
              : spaceOccupied ? SPACE_ANSWER_MEANS.used : SPACE_ANSWER_MEANS.empty}
            {a.pausedByHibernation !== true && <>{' '}{PAUSED_NEW_BILLS}</>}
          </div>
          {/*
            10/19 — SAY WHAT THE ANSWER WAIVES BEFORE IT IS GIVEN.
            Stopping the count covers every month still open outright, which is
            the same thing turning hours off entirely does (the 10/18 rule in
            jobs/workTradeSettlement loadOpenPeriods). That is correct — a work
            trade's coverage is never turned into a debt — but it CLEARS hours
            carried over from months when the space was in use, and that is the
            landlord's money. So it is priced here, in front of them, while they
            can still pick the other answer.
          */}
          {spaceOccupied !== false && carriedWaiverNote}
        </div>
      )}

      {/* ── 10/19: pause it (landlord), asking about the space in the same step ── */}
      {isLandlord && a.status === 'active' && (
        <div style={{ marginTop: 4, marginBottom: 12 }}>
          {!pausing ? (
            <button className="btn btn-ghost btn-sm" onClick={() => setPausing(true)}>Pause this agreement</button>
          ) : (
            <div className="card" style={card}>
              <div style={{ fontSize: '.84rem', color: 'var(--text-1)', marginBottom: 4 }}>
                Pause it? Jobs they have taken go back on the board, and nothing is ended — any hours still owed stay owed.
              </div>
              <div style={{ fontSize: '.84rem', color: 'var(--text-1)', marginBottom: 4 }}>
                While it is paused, is the space still being used?
              </div>
              <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginBottom: 8, lineHeight: 1.5 }}>
                A camper left parked on the spot over the summer is still using it. One taken home for the season is not.
                {tracks ? '' : ' No hours are counted on this agreement either way.'}
              </div>
              {/*
                10/19 (review): priced HERE, before the answer is given — this is
                the card where "The space is empty" gets picked for the first
                time, and picking it clears the catch-up from every month still
                open. See carriedWaiverNote.
              */}
              {tracks && carriedWaiverNote}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                <button className="btn btn-primary btn-sm" disabled={patch.isLoading}
                  onClick={() => { setPausing(false); patch.mutate({ status: 'paused', spaceOccupiedWhilePaused: true }) }}>
                  {SPACE_IN_USE}
                </button>
                <button className="btn btn-primary btn-sm" disabled={patch.isLoading}
                  onClick={() => { setPausing(false); patch.mutate({ status: 'paused', spaceOccupiedWhilePaused: false }) }}>
                  {SPACE_EMPTY}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setPausing(false)}>Cancel</button>
              </div>
              <div style={{ fontSize: '.74rem', color: 'var(--text-2)', marginTop: 8, lineHeight: 1.5 }}>
                {tracks && <>{SPACE_IN_USE}: {SPACE_ANSWER_MEANS.used} {SPACE_EMPTY}: {SPACE_ANSWER_MEANS.empty}{' '}</>}
                {PAUSED_NEW_BILLS}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── 10/19: start it again (landlord) ── */}
      {/*
        NOT offered on a trade that lease hibernation paused. Waking the trade
        while its lease sleeps would leave it counting hours against a month that
        bills nothing, and `paused_by_hibernation` would still be set, so the
        lease waking up later would expect to be the thing that resumes it. The
        lease is the switch there, and this says so instead of pretending.
      */}
      {isLandlord && asleep && (
        <div style={{ marginTop: 4, marginBottom: 12 }}>
          {a.pausedByHibernation === true ? (
            <div style={{ fontSize: '.76rem', color: 'var(--text-3)', lineHeight: 1.5 }}>
              This paused when their spot went to sleep for the season. Waking the lease back up starts the work trade again too.
            </div>
          ) : (
            <>
              <button className="btn btn-primary btn-sm" disabled={patch.isLoading}
                onClick={() => patch.mutate({ status: 'active' })}>Start this agreement again</button>
              <div style={{ fontSize: '.74rem', color: 'var(--text-3)', marginTop: 6 }}>
                Hours count again from here, and the space answer is forgotten — the next pause asks it fresh.
              </div>
            </>
          )}
        </div>
      )}

      {/* ── end it (landlord) ── */}
      {isLandlord && a.status !== 'ended' && (
        <div style={{ marginTop: 4 }}>
          {!ending ? (
            <button className="btn btn-ghost btn-sm" onClick={() => setEnding(true)}>End this agreement</button>
          ) : (
            <div className="card" style={{ ...card, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ flex: 1, fontSize: '.8rem', color: 'var(--text-1)' }}>
                End it now? Any hours still owed are billed immediately, and their Work Trade tab closes.</span>
              <button className="btn btn-primary btn-sm" disabled={patch.isLoading} onClick={() => patch.mutate({ status: 'ended', endDate: new Date().toISOString().slice(0, 10) })}>End agreement</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setEnding(false)}>Cancel</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
