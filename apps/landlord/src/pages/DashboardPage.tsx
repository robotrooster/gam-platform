import React, { useState, useRef } from 'react'
import { useQuery } from 'react-query'
import { humanize , DISBURSEMENT_TRIGGER_LABEL } from '@gam/shared'
import { apiGet } from '../lib/api'
import { useNavigate } from 'react-router-dom'
import { useDashboardCards } from '../lib/useDashboardCards'
import { AlertTriangle, CheckCircle, Activity, ArrowDownToLine, Clock, FileText, CreditCard, Wrench, ChevronRight, HeartHandshake, UserPlus, LogOut, Home } from 'lucide-react'
import { fmtWhole } from '../lib/format'
import { PropertySelect } from '../components/ListControls'
// 10/12 (Nic): no "Money received" / "Money billed" switch — the income card
// and the property-health card show Charged, Received and Owed side by side.
import {
  moneyCardView, rentBillsPaidRate, healthStatus, HEALTH_STATUS_LABEL,
  // 10/18 (Nic): the health block's own figures, printed as the subtraction
  // they are, and the words that keep the money table beside them from reading
  // as its parts (see the helper for the Mountain View figures).
  rentHealthFigures, allMoneyHeading, moneyColumns,
  MONEY_COLUMNS_DO_NOT_SUBTRACT, HEALTH_TRACE_NOTE,
  activeCategories, categoryLabel, categoryThree, sumThree, reportErrorText, monthToDate,
  type IncomeCardData, type CategoryRow, type RentHealthData,
} from '../lib/incomeBasis'
import { MONEY_COLUMN_LABEL } from '@gam/shared'
import '../styles/reports-basis.css'
// KPI cards show full dollars without cents (fmtWhole). Tables below keep this
// exact, with-cents `fmt` — precise figures belong in the tables.
const fmt = (n: any) => n != null ? `$${Number(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}` : '—'

interface DashStats {
  activeUnits: number
  vacantUnits: number
  delinquentUnits: number
  suspendedUnits: number
  evictionModeUnits: number
  monthlyRentVolume: number
  collectedMtd: number
  /** S642: of collectedMtd, how much is ACH still clearing. */
  collectedInFlight?: number
  outstanding: number
  // S640: rent that trades for labor — contracted, real, and never arriving as
  // money. Reported apart from monthlyRentVolume/outstanding, not inside them.
  workTradeRent?: number
  workTradeUnits?: number
  workTradeSuspended?: number
  /** S640: YYYY-MM-DD, from the payout engine. The card never derives it. */
  nextPayoutDate?: string
  // S640: of the delinquent units, how many a late fee will actually reach
  // tonight. Onboarding residents are waived, so the two numbers differ.
  delinquentUnitsAccruingLateFees?: number
  /** S641: units owing ANYTHING, propane installments aside. What the card means. */
  unitsOwing?: number
  /** S654: of those, open charges past their lease's grace period — delinquent. */
  unitsPastGrace?: number
  totalUnits: number
  occupancyRate: number
  leasesExpiring30d: number
  leasesExpiring60d: number
  propertyCount: number
  upcomingDisbursement: { count: number; amount: number }
  // S640: rent we are holding that goes out on the next weekly run, and the
  // part still clearing at the tenant's bank behind it.
  nextPayoutReady?: number
  nextPayoutClearing?: number
  otpUnits?: number
  projectedOtpDisbursement?: number
  platformFee?: number
  platformFeeByProperty?: { propertyId: string; name: string; fee: number }[]
  /** S655: the income card, both ways. 10/12: shown side by side (Charged / Received / Owed). */
  incomeCard?: IncomeCardData
  /**
   * S655: the rent card, both ways (rent only) — the twin of what Reports
   * shows as collected this month. 10/17: the health card no longer divides
   * these (see rentHealth); they answer "what was charged and what arrived".
   */
  rentCard?: {
    received: { amount: number; clearing: number }
    billed: { amount: number; collected: number; clearing: number; stillOwed: number }
  }
  /**
   * 10/17 (Nic): what the payment-health percentage reads — this month's rent
   * bills invoiced against paid, bills on hold for work trade left out of both
   * sides, a bill paid once settled whatever settled it. Its `owed` is this
   * month's RENT left to collect, which is NOT the Outstanding card's figure
   * (every open charge, every month) — the note under the card says so.
   * 10/18: the Outstanding card really does count every open charge now; it
   * summed unpaid invoice balances, which dropped the late fees (routes/landlords).
   */
  rentHealth?: RentHealthData
  /**
   * S655 (decision #4): this month's income by category — the property
   * report's own totals. A DIFFERENT question from rentHealth above: every kind
   * of money, not just rent, and its Owed column is what tenants still owed at
   * the END of the month, every bill of every month included once the company's
   * books are live (`source` says which words the columns get). 10/18 (Nic):
   * the card says all of that on screen, because $26,211.02 charged beside
   * $19,483.98 received beside $9,683.87 owed reads as a subtraction and is not
   * one.
   */
  propertyHealth?: {
    period: string
    categories: CategoryRow[]
    lines: Array<{ line: string; label: string; amount: number }>
    total: number
    source?: 'ledger' | 'records'
  }
  trend?: TrendMonth[]
}

/** One month of the trend: money received that month, split rent / everything else, by category. */
interface TrendMonth {
  month: string
  period: string
  revenue: number
  rentRevenue: number
  otherRevenue: number
  categories?: Array<{ category: string; label: string; amount: number; billed: number; collected: number }>
}

export function DashboardPage() {
  const navigate = useNavigate()
  const [showFeeModal, setShowFeeModal] = useState(false)

  // ── S637: SEE ONE PROPERTY AT A TIME ────────────────────────────────
  //
  // Nic: "I need to be able to filter from the dashboard to see what other
  // co-owners are seeing. Right now, all properties are blended on the
  // dashboard. And when a co-owner only sees one property because they don't
  // own all the properties together with me, they're seeing different
  // information on the cards."
  //
  // Scope is by entity and each entity owns properties, so a co-owner's view
  // is a subset of this one. Narrowing to a single property reproduces what
  // they see without impersonating anybody. Empty string is the blended view,
  // which stays the default.
  const [propertyId, setPropertyId] = useState('')

  const { data: properties = [] } = useQuery<any[]>(
    'properties', () => apiGet<any[]>('/properties'), { staleTime: 60_000 })

  const { data: stats, isLoading, isPreviousData, isError, error } = useQuery<DashStats>(
    ['dashboard', propertyId],
    () => apiGet(`/landlords/me/dashboard${propertyId ? `?propertyId=${propertyId}` : ''}`),
    { staleTime: Infinity, keepPreviousData: true }
  )

  const { data: disbursements } = useQuery(
    'disbursements-recent',
    () => apiGet<any[]>('/disbursements'),
    { select: (d: any) => d?.slice(0, 5) }
  )


  // Pad trend to always show 6 months. Each month is the money received that
  // month — the Received figure of its row on Reports and, for this month, the
  // income card — matched by its 'YYYY-MM' period.
  const trendData = (() => {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    const now = new Date()
    const slots = Array.from({length:6}, (_,i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - 5 + i, 1)
      return { month: months[d.getMonth()], period: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }
    })
    const apiTrend: TrendMonth[] = stats?.trend || []
    return slots.map(s => {
      const r = apiTrend.find(x => x.period === s.period) ?? apiTrend.find(x => !x.period && x.month === s.month)
      // S639: rent and everything else, so the tooltip can explain how a beat
      // splits between lot/space rent and the rest.
      return {
        month: s.month,
        revenue: r?.revenue || 0,
        rentRevenue: r?.rentRevenue || 0,
        otherRevenue: r?.otherRevenue || 0,
      }
    })
  })()
  // Nothing to show and the load failed: say so rather than a page of $0.
  const loadFailed = isError && !stats
  // 10/12 (Nic): this month's Charged, Received and Owed side by side — the
  // same card the Reports overview shows — with how they tie under it.
  const incomeCard = moneyCardView(stats?.incomeCard)

  // Platform fee: authoritative per-property number from the API — $2/billable
  // unit floored at the $10 property minimum (full stop), summed across every
  // property. Same calc the billing cron + Reports use, so this matches the bill.
  // Full rent roll = every occupied unit (active + delinquent + suspended).
  // Backs the "Expected Monthly Rent" subtext so the count matches the units
  // actually summed into that figure. (direct_pay retired W-15/S531.)
  const rentRollUnits = (stats?.activeUnits || 0) + (stats?.delinquentUnits || 0) + (stats?.suspendedUnits || 0)
  // S654 (Nic): "I did mark one unit as owner use… it should say 68 occupied
  // units." The owner lives there: occupied (and billed), just not rented.
  const occupiedUnits = rentRollUnits + Number((stats as any)?.ownerUseUnits ?? 0)
  // The fee card counts what the bill counted, once the month is billed.
  const platformFeeUnits = Number((stats as any)?.platformFeeUnits ?? occupiedUnits)
  // S640 (Nic, DIRECTIVE): work trade is revenue that is never coming in as
  // money. It is out of Expected and out of Outstanding, and stands on its own
  // so the landlord can still see what the trades are worth.
  const workTradeUnits = Number(stats?.workTradeUnits ?? 0)
  // S650: hibernating leases are asleep — occupied, never payable.
  // 10/12: the spaces summed into Expected Monthly Rent — every space an active
  // lease holds, less work trade and hibernating leases (the API counts them
  // beside the sum, so the two can never disagree).
  const payableUnits   = Number((stats as any)?.payableRentUnits
    ?? Math.max(rentRollUnits - workTradeUnits - Number((stats as any)?.hibernatingUnits ?? 0), 0))
  const platformFee = stats?.platformFee ?? 0
  const platformFeeByProperty: { propertyId: string; name: string; fee: number }[] =
    (stats as any)?.platformFeeByProperty ?? []

  // ── S640: THE DATE COMES FROM THE ENGINE NOW ───────────────────────────
  //
  // This card computed its own payout date and was wrong three times running:
  // it said Friday while the engine fired Tuesday, then Tuesday while Nic moved
  // the run to Thursday — telling him "Sep 15" when the job would not fire until
  // Sep 17. Two copies of a schedule is one copy too many.
  //
  // The API returns the date the payout job will actually fire, derived from
  // the engine's own gate, holiday shifts and all. No fallback guess: if it is
  // absent the card simply does not name a day, which is better than naming the
  // wrong one.
  const nextPayoutDate = stats?.nextPayoutDate
    ? new Date(stats.nextPayoutDate + 'T12:00:00Z')
        .toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    : null

  // 10/21 (Nic): "rearranging the dashboard widgets." ABOVE the loading
  // branch — a hook after an early return is a hook that sometimes does not
  // run, and React counts them.
  const dash = useDashboardCards()

  if (isLoading) return (
    <div>
      <div className="page-header">
        <div><div className="skeleton" style={{width:200,height:28,marginBottom:8}} /><div className="skeleton" style={{width:160,height:16}} /></div>
      </div>
      <div className="kpi-grid">{[1,2,3,4].map(i => <div key={i} className="kpi-card skeleton" style={{height:100}} />)}</div>
    </div>
  )

  return (
    <div>
      {/* 10/21 (Nic): "a reset button down to default view at the bottom of the
          page. Or maybe it only appears at the top next to the notification
          banner when they've redragged."
          Up here with the banners, and only once somebody HAS redragged —
          a way back is only worth a line on the screen to the person who needs
          one, and the way back is what they will be looking for at the top. */}
      {dash.customized && (
        <div style={{ display:'flex', justifyContent:'flex-end', marginBottom: 8 }}>
          <button type="button" onClick={dash.reset}
            style={{ background:'none', border:'1px solid var(--border)', borderRadius: 8,
                     color:'var(--text-3)', fontSize:'.72rem', padding:'4px 10px', cursor:'pointer' }}>
            Reset to the default view
          </button>
        </div>
      )}
      {/* Alerts */}
      {/* ── S637: THE CONNECT BANNER IS GONE ────────────────────────────
          S605 put a banner here reading "Tenants can't pay rent yet". It was
          wrong on the facts and wrong to show.

          Wrong on the facts: routes/payments.ts:389 does not block a tenant
          whose landlord has no payout-ready Connect account. It falls back to
          a standard charge, the money lands on GAM's platform balance as
          platform_held, and services/landlordPassthrough.ts releases it the
          moment Connect completes. Its own comment says why — "Otherwise
          tenants hit a wall and spend the rent before we can collect." Rent
          collects the whole time. Only the PAYOUT waits.

          Wrong to show: Nic (DIRECTIVE) — "we don't want other landlords to see
          that banner. I've gotta think about it from that perspective." A
          landlord's dashboard is a screen they open in front of staff and
          co-owners; a red bar announcing their bank is not set up is not
          information they asked to broadcast.

          The prompt to finish Connect is NOT lost — GET /landlords/me/todos
          still carries the bank/KYC task, scoped across every entity the
          account owns, and Settings still shows bank_account_ready. Those are
          places the landlord goes to look, rather than a claim shouted at them
          on arrival. Do not restore this banner. */}
      {(stats?.evictionModeUnits || 0) > 0 && (
        <div className="alert alert-danger" style={{cursor:'pointer'}} onClick={()=>navigate('/units?status=eviction')}>
          <AlertTriangle size={16} />
          <div>
            <strong>{stats!.evictionModeUnits} unit(s) in Eviction Mode</strong> — All tenant ACH hard blocked. No rent will be collected. Disbursement held. Check your local laws before accepting any payment.
          </div>
          <span style={{marginLeft:'auto',fontSize:'.78rem',fontWeight:600}}>View →</span>
        </div>
      )}
      {/* ── S641 (Nic): "it needs to read any outstanding charges" ──────────
          The units table counts unpaid RENT only — correct for the eviction
          clock, wrong for a card a landlord reads as "who owes me". Jeremy
          Parker paid his rent and not his electricity, so his spot read clean
          while the money was still owed. */}
      {(stats?.unitsOwing ?? stats?.delinquentUnits ?? 0) > 0 && (
        // S641: opens the BALANCES page, not the delinquent-unit filter. The
        // banner now counts anyone owing anything, and /units?status=delinquent
        // would show two of the three — a card that disagrees with the page it
        // opens is the bug this whole pass has been about. 10/13 (Nic):
        // "REMOVE the Outstanding Balances tab" — who owes is on Payments now
        // (owing rows at the top, "Delinquent" beside the name).
        // S654 (Nic): "until a unit is actually delinquent past its grace
        // period, I would really love for that to say outstanding units… flag a
        // difference between outstanding and delinquent based on when the grace
        // period ends." Outstanding = owes anything; delinquent = a charge still
        // open after its grace period. The late-fee line is only said when a fee
        // will actually be charged — the API reads each lease's own terms.
        <div className="alert alert-warn" style={{cursor:'pointer'}} onClick={()=>navigate('/payments')}>
          <Clock size={16} />
          {(() => {
            const owing = stats!.unitsOwing ?? stats!.delinquentUnits ?? 0
            const past = stats?.unitsPastGrace ?? 0
            const accruing = stats?.delinquentUnitsAccruingLateFees ?? 0
            return (
              <>
                <strong>{owing} unit{owing === 1 ? '' : 's'} with an outstanding balance</strong>
                {past > 0
                  ? <> — <strong>{past} delinquent</strong> (past the grace period).{' '}</>
                  : <> — none past the grace period yet.{' '}</>}
                {accruing > 0
                  ? `Late fees accruing on ${accruing}.`
                  : past > 0 ? 'No late fees accruing.' : ''}
              </>
            )
          })()}
          <span style={{marginLeft:'auto',fontSize:'.78rem',fontWeight:600}}>View →</span>
        </div>
      )}
      {((stats as any)?.leasesNeedReview || 0) > 0 && (
        <div className="alert alert-warn" style={{cursor:'pointer'}} onClick={()=>navigate('/leases?review=1')}>
          <AlertTriangle size={16} />
          <strong>{(stats as any).leasesNeedReview} lease(s) need review</strong> — Imported with default values. Open to confirm the real terms.
          <span style={{marginLeft:'auto',fontSize:'.78rem',fontWeight:600}}>View →</span>
        </div>
      )}


      {/* S637: one property at a time. PropertySelect hides itself for a
          single-property landlord, so this costs nothing for most accounts.
          10/12 (Nic): the Money received / Money billed switch is gone. */}
      {properties.length > 1 && (
      <div className="dash-basis-bar">
        {properties.length > 1 && (
          <div className="dash-prop-filter">
            <PropertySelect
              value={propertyId}
              onChange={setPropertyId}
              properties={(properties as any[]).map(p => ({ id: p.id, name: p.name }))}
              allLabel="All properties"
            />
            {propertyId && (
              <span className="dash-prop-note">
                Showing one property — this is the view a co-owner of it sees.
              </span>
            )}
          </div>
        )}
      </div>
      )}

      {/* S655: a dashboard that could not load says so once, in plain words —
          it used to fall through to a grid of $0 cards that read as real. */}
      {loadFailed && (
        <div className="alert alert-warn" role="alert">
          <AlertTriangle size={16} />
          <span>{reportErrorText(error, 'your dashboard figures')}</span>
        </div>
      )}

      {/* KPI Grid — 12-col so we can run 3 / 4 / 3 cards per row (spans 4 / 3 / 4). */}
      {/* While a new property loads, the last figures stay up dimmed
          rather than reading as the new choice's numbers. */}
      {/* 10/22 (Nic): ONE grid for the whole page, because "it should be able
          to be anything on the page. I could drag my to-do list to the top as
          well if I wanted." A card can only trade places with another card in
          the same grid, so the big panels below had to come inside it.
          The figures stay behind their own guard (a fragment, which adds no
          element, so its cards remain direct children of the grid) — a failed
          load still leaves the panels and the to-do list on screen, as before.
          `alignItems: start` keeps a short card from stretching to the height
          of a tall panel that landed in its row. */}
      <div className="kpi-grid dash-kpis" style={{gridTemplateColumns:"repeat(12, 1fr)", alignItems: 'start', opacity: isPreviousData ? 0.55 : 1, transition: 'opacity .15s'}}
           aria-busy={isPreviousData || undefined}>
      {!loadFailed && (<>
        {/* Row 1 (span 4): rent money trio */}
        {/* 10/12 (Nic): the rent the active LEASES bill (never a unit's listed
            rent; a space marked occupied with no active lease adds nothing),
            with work trade and hibernating leases left out (the figure the
            10/12 Rent Roll's lease_rent.expected showed, retired 10/13).
            10/13 (Nic): "Dashboard 'Expected Monthly Rent' card opens
            PAYMENTS" — this month's rent roll (it opened the Rent Roll's
            history before). */}
        <div className="kpi-card" {...dash.bind('expected-rent')} onClick={()=>navigate('/payments')}>
          <div className="kpi-label">Expected Monthly Rent</div>
          <div className="kpi-value gold">{fmtWhole(stats?.monthlyRentVolume || 0)}</div>
          {/* S641 (Nic): the "$2,869 traded for work on 6" clause is gone — he
              knows what his trades are and does not need the figure quoted back
              on the rent card every time he opens the dashboard. The count
              stays, and now says what it is counting against, so the number
              reconciles with the Occupied Units card instead of looking like a
              third unexplained figure. */}
          <div className="kpi-sub">
            payable across {payableUnits} of {occupiedUnits} occupied unit{occupiedUnits === 1 ? '' : 's'}
          </div>
        </div>
        <div className="kpi-card" {...dash.bind('money-this-month')} onClick={()=>navigate('/reports')}>
          {/* 10/18 (Nic): the label says what the card covers. Three figures in
              a row read as a subtraction, and these do not subtract: Received is
              money on the day it arrived, Charged is this month's bills, Owed is
              what is still unpaid of them. The notes under them say how Charged
              ties; Reports labels each figure separately ("Received this month",
              "Owed of this month's bills") and this card had only "This month"
              for all three, beside a rent percentage that counts neither. */}
          <div className="kpi-label">This month — every kind of money</div>
          {/* 10/12 (Nic): Charged, Received and Owed side by side, from the same
              facts as Reports. S642 (Nic): money in flight is shown — still
              clearing, never inside Received. */}
          <div className="dash-three">
            {/* 10/12 (Nic, L2): Received leads. */}
            <div><span className="dash-three-label">{MONEY_COLUMN_LABEL.received}</span><span className="dash-three-value green">{fmtWhole(incomeCard.received)}</span></div>
            <div><span className="dash-three-label">{MONEY_COLUMN_LABEL.charged}</span><span className="dash-three-value">{fmtWhole(incomeCard.charged)}</span></div>
            <div><span className="dash-three-label">{MONEY_COLUMN_LABEL.owed}</span><span className="dash-three-value" style={{ color: incomeCard.owed > 0 ? 'var(--amber)' : undefined }}>{fmtWhole(incomeCard.owed)}</span></div>
          </div>
          <div className="kpi-sub" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {incomeCard.notes.map(n => <span key={n}>{n}</span>)}
          </div>
        </div>
        {/* S527 W-3: outstanding → the who-owes-what list, not Reports.
            10/13 (Nic): that list is Payments now (Outstanding Balances removed). */}
        <div className="kpi-card" {...dash.bind('outstanding')} onClick={()=>navigate('/payments')}>
          <div className="kpi-label">Outstanding</div>
          <div className="kpi-value" style={{color:(stats?.outstanding||0)>0?'var(--amber)':'var(--text-0)'}}>{fmtWhole(stats?.outstanding || 0)}</div>
          {/* S650 (Nic): no small print about work-trade balances here.
              10/18 (Nic): "outstanding in the top KPI card only shows $1,415"
              — beside a block counting this month's rent and a table counting
              the balance at month end. It says which months it covers now, the
              way Reports does ("every month still owed").
              It also says WHAT it covers, because that changed with it: the
              figure was unpaid INVOICE balances, which left out every accrued
              late fee (they sit outside invoices.total_amount by design), and
              it now reads the one shared open-charge rule the balances page
              this card opens reads — the words RENT_HEALTH_SCOPE_NOTE already
              uses of this card, "every open charge of every month". */}
          <div className="kpi-sub">every open charge, every month</div>
        </div>
        {/* Row 2 (span 3): portfolio + operations */}
        <div className="kpi-card" {...dash.bind('occupancy-rate')} onClick={()=>navigate('/units')}>
          <div className="kpi-label">Occupancy Rate</div>
          <div className="kpi-value">{stats?.occupancyRate ?? 0}%</div>
          <div className="kpi-sub">{stats?.activeUnits || 0} of {stats?.totalUnits || 0} units active</div>
        </div>
        {/* S527 W-4: land pre-filtered to active units. */}
        {/* S641 (Nic): "my active units KPI card says thirty three, and the
            expected monthly rent card only says thirty. So you have a three
            unit distinction."
            He is right and the gap was a definition, not a bug: this card
            counted status='active' ONLY, while the rent card counted every
            OCCUPIED space — active, delinquent, suspended. A delinquent space
            has somebody living in it and owing rent; excluding it here and
            including it there put two different denominators on one screen.
            Occupied is occupied — the same rule the utility billing follows. */}
        <div className="kpi-card" {...dash.bind('occupied-units')} onClick={()=>navigate('/units?status=occupied')}>
          <div className="kpi-label">Occupied Units</div>
          <div className="kpi-value green">{occupiedUnits}</div>
          <div className="kpi-sub">{stats?.vacantUnits || 0} vacant</div>
        </div>
        {/* S527 W-5: land pre-filtered to the expiring window. */}
        <div className="kpi-card" {...dash.bind('leases-expiring')} onClick={()=>navigate('/leases?expiring=60')}>
          <div className="kpi-label">Leases Expiring</div>
          <div className="kpi-value" style={{fontSize:'1.4rem',color:(stats?.leasesExpiring30d||0)>0?'var(--amber)':'var(--text-0)'}}>{stats?.leasesExpiring30d || 0} in 30d</div>
          <div className="kpi-sub">{stats?.leasesExpiring60d || 0} within 60 days</div>
        </div>
        <div className="kpi-card" {...dash.bind('maintenance')} onClick={()=>navigate('/maintenance')}>
          <div className="kpi-label">Maintenance</div>
          <div className="kpi-value" style={{fontSize:'1.4rem'}}>{(stats as any)?.maintenance?.openRequests||0} open</div>
          <div className="kpi-sub">{(stats as any)?.maintenance?.inProgress||0} in progress · {(stats as any)?.maintenance?.completed30d||0} done this month</div>
        </div>
        {/* Row 3 (span 6): applications + next payout */}
        <div className="kpi-card" {...dash.bind('applications')} onClick={()=>navigate('/background')}>
          <div className="kpi-label">Applications</div>
          <div className="kpi-value" style={{fontSize:'1.4rem',color:(stats as any)?.bgPending>0?'var(--amber)':'var(--green)'}}>{(stats as any)?.bgPending||0}</div>
          <div className="kpi-sub">{(stats as any)?.bgPending>0?'pending review':'no pending applications'}</div>
        </div>
        {/* S605 (Nic): "disbursements kpi card on overview is not clickable. i
            see no way to see the history." Every other KPI here navigates; this
            one didn't, so the payout history was only reachable by knowing to
            look under Financials. */}
        <div className="kpi-card" {...dash.bind('disbursements')} onClick={()=>navigate('/disbursements')}>
          {/* S640 (Nic): "It's still showing a next disbursement of zero
              dollars. The landlord's expecting money to be handled and moved.
              They wanna know what's about to hit their bank."

              It read the table of payouts ALREADY FIRED, so before the first
              one it said $0 — while $2,049 of collected rent sat waiting to be
              sent. Now it says what is going out, and names the part still
              clearing separately rather than folding it in: quoting money that
              has not cleared as "arriving Tuesday" is a promise we cannot
              keep. */}
          <div className="kpi-label">Next Disbursement</div>
          <div className="kpi-value" style={{fontSize:'1.4rem'}}>
            {fmtWhole(Number(stats?.nextPayoutReady ?? 0) || (stats?.upcomingDisbursement?.amount || 0))}
          </div>
          <div className="kpi-sub flex items-center gap-8">
            <span className="status-dot dot-green" />
            {Number(stats?.nextPayoutReady ?? 0) > 0
              ? (nextPayoutDate ? `On its way to your bank — sent ${nextPayoutDate}` : 'On its way to your bank')
              : (nextPayoutDate ? `Next payout ${nextPayoutDate}` : 'Next payout scheduled')}
          </div>
          {Number(stats?.nextPayoutClearing ?? 0) > 0 && (
            <div className="kpi-sub" style={{color:'var(--text-3)'}}>
              {fmtWhole(Number(stats?.nextPayoutClearing))} still clearing at the tenant's bank
            </div>
          )}
        </div>
        {/* Row 4: what you pay GAM.
            S642 (Nic): the landlord referral program is withdrawn — "not
            having something there is better than offering it to landlords and
            then taking it away", and it cannot survive landlords onboarding
            free. The Referral Earnings and Net Platform Cost cards went with
            it; this one widens to fill the row rather than leaving a gap where
            an offer used to be. */}
        <div className="kpi-card" {...dash.bind('platform-fee')} onClick={()=>setShowFeeModal(true)}>
          <div className="kpi-label">Platform Fee / Mo</div>
          <div className="kpi-value">{fmtWhole(platformFee)}</div>
          <div className="kpi-sub">{platformFeeUnits} occupied × $2/unit · $10/property min</div>
        </div>
      </>)}

        {/* Property health — an animated ECG whose 6 beats are the last 6
            months of rent collected (taller beat = stronger month). */}
        {!loadFailed && (
          <div {...(() => { const b = dash.bind('property-health')
            return { ...b, style: { ...b.style, alignSelf: 'stretch' } } })()}>
            <PropertyHealthMonitor
              months={trendData}
              health={stats?.rentHealth}
              thisMonth={stats?.propertyHealth}
              stale={isPreviousData}
            />
          </div>
        )}

        {/* Recent disbursements.
            10/22 (Nic): "just link it, have the recent disbursements card auto
            size to be the same as whatever the property health is. That way, if
            that size of that one fluctuates, the recent disbursement one
            fluctuates as well."
            It does fluctuate: Property Health draws a fixed chart but lists one
            row per money category that actually has money in it — a park that
            bills trash, water and electric is three rows taller than one that
            bills none, and a heavy register month adds another. So no fixed
            height would have held.
            A grid row already equalises its items' heights; the dashboard sets
            `alignItems: start` so a short KPI card does not stretch beside a
            tall panel, and this opts back in. It matches whatever shares its
            row, which survives being dragged somewhere else. */}
        <div className="card" {...(() => { const b = dash.bind('recent-disbursements')
          return { ...b, style: { ...b.style, alignSelf: 'stretch', display: 'flex', flexDirection: 'column' } } })()}>
          <div className="card-header">
            <span className="card-title">Recent Disbursements</span>
            {/* S605: an icon is not a way out. Give the panel a real link to the
                full history, the way the other dashboard panels do. */}
            <span style={{display:'flex',alignItems:'center',gap:8}}>
              <span onClick={()=>navigate('/disbursements')}
                    style={{fontSize:'.74rem',fontWeight:600,color:'var(--gold)',cursor:'pointer'}}>
                View all →
              </span>
              <ArrowDownToLine size={16} style={{color:'var(--text-3)'}} />
            </span>
          </div>
          {/* 10/22 (Nic): "you don't need to see freaking necessarily 10 miles
              long of different payouts" — the list scrolls inside the card, so
              the payouts never decide how tall it is. */}
          {disbursements?.length ? (
            <div style={{flex:1,minHeight:0,overflowY:'auto'}}>
            <table className="data-table">
              <thead><tr>
                {/* 10/22 (Nic): "a little column that... shows which went to
                    which property. Because I have two disbursements on the 12th
                    and two disbursements on the 19th... especially with 10
                    properties or entities."
                    It names the COMPANY, not the property: a payout is per
                    entity (see routes/disbursements — landlord_id, no
                    property_id), which is exactly the Mountain View / Oak Park
                    split he is reading. Calling it a property would be a
                    friendlier word for the wrong thing. */}
                <th>Date</th><th>Company</th><th>Amount</th><th>Trigger</th><th>Status</th>
              </tr></thead>
              <tbody>
                {disbursements.map((d: any) => {
                  const dateStr = d.createdAt ?? d.targetDate
                  return (
                    <tr key={d.id}>
                      <td className="mono">{dateStr ? new Date(dateStr).toLocaleDateString() : '—'}</td>
                      <td style={{fontSize:'.78rem',maxWidth:140,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}
                          title={d.companyName || ''}>
                        {d.companyName || '—'}
                      </td>
                      <td className="mono" style={{color:'var(--green)'}}>{fmt(d.amount)}</td>
                      <td style={{fontSize:'.78rem'}}>
                        {DISBURSEMENT_TRIGGER_LABEL[d.triggerType] ?? (d.triggerType ? humanize(d.triggerType) : '—')}
                      </td>
                      <td><span className={`badge ${d.status === 'settled' ? 'badge-green' : d.status === 'pending' || d.status === 'processing' ? 'badge-amber' : 'badge-red'}`}>{humanize(d.status)}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
          ) : (
            <div style={{color:'var(--text-3)',fontSize:'.82rem',padding:'16px 0'}}>No disbursements yet.</div>
          )}
        </div>

        {/* To-Do List — a place on the board like everything else now. */}
        <div {...dash.bind('todo')}><TodoCard /></div>
      </div>

      {/* S159: PM cut MTD vs net to owner — only renders when there's
            an active PM linkage with measurable cut this month. Not one of the
            draggable places: it appears and disappears on its own. */}
      <PmCutThisMonthCard />

      {showFeeModal && (
        <div className="modal-overlay" onClick={()=>setShowFeeModal(false)}>
          <div className="modal" style={{maxWidth:480}} onClick={e=>e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">Platform Fee Breakdown</span>
              <button className="btn btn-ghost btn-sm" onClick={()=>setShowFeeModal(false)}>✕</button>
            </div>
            <div style={{padding:'0 24px 24px'}}>
              <table className="data-table" style={{marginTop:8}}>
                <thead>
                  <tr><th>Property</th><th style={{textAlign:'right'}}>Monthly Fee</th></tr>
                </thead>
                <tbody>
                  {platformFeeByProperty.length ? platformFeeByProperty.map(p => (
                    <tr key={p.propertyId}>
                      <td style={{color:'var(--text-0)'}}>{p.name}</td>
                      <td className="mono" style={{textAlign:'right',color:'var(--gold)'}}>{fmt(p.fee)}</td>
                    </tr>
                  )) : (
                    <tr><td colSpan={2} style={{textAlign:'center',color:'var(--text-3)',padding:16}}>No properties yet.</td></tr>
                  )}
                </tbody>
                <tfoot>
                  <tr style={{borderTop:'1px solid var(--border-2)'}}>
                    <td style={{fontWeight:600}}>Total Monthly Fee</td>
                    <td className="mono" style={{textAlign:'right',fontWeight:600,color:'var(--gold)'}}>{fmt(platformFee)}</td>
                  </tr>
                </tfoot>
              </table>
              <div style={{marginTop:16,fontSize:'.78rem',color:'var(--text-3)'}}>
                $2 per occupied unit · $10 per-property monthly minimum (charged on every property)
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function TodoCard() {
  const navigate = useNavigate()
  const [expanded, setExpanded] = React.useState<{ stayMoney: boolean; paidAhead: boolean; depositRefunds: boolean; onboarding: boolean; leases: boolean; ach: boolean; maintenance: boolean; workTrade: boolean }>({ stayMoney: false, paidAhead: false, depositRefunds: false, onboarding: false, leases: false, ach: false, maintenance: false, workTrade: false })

  const { data: todos, isLoading } = useQuery<any>(
    'landlord-todos',
    () => apiGet('/landlords/me/todos'),
    { staleTime: 30000 } // 30s
  )

  if (isLoading) {
    return (
      <div className="card mt-16" style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)' }}>
        Loading to-dos…
      </div>
    )
  }

  const counts = todos?.counts || { onboarding: 0, leases: 0, ach: 0, maintenance: 0, workTrade: 0, total: 0 }

  // All-clear state
  if (counts.total === 0) {
    return (
      <div className="card mt-16">
        <div className="card-header">
          <span className="card-title">To-Do</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '32px 0', gap: 10 }}>
          <CheckCircle size={32} style={{ color: 'var(--green)', opacity: 0.8 }} />
          <div style={{ fontSize: '.88rem', color: 'var(--text-1)', fontWeight: 600 }}>All clear</div>
          <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>Nothing needs your attention right now.</div>
        </div>
      </div>
    )
  }

  const sections = [
    // 10/4 (decisions #38 Q5): an early check-out's money still waiting on a stay.
    { key: 'stayMoney', label: 'Early check-outs', icon: LogOut, color: 'var(--gold)', items: todos?.stayMoney || [] },
    // 10/4 (decisions #46.1): money paid ahead left on an ended lease, waiting on the landlord's choice.
    { key: 'paidAhead', label: 'Money paid ahead', icon: CreditCard, color: 'var(--gold)', items: todos?.paidAhead || [] },
    // 10/4 (decisions #47a): part of a move-out's deposit refund still to go back.
    { key: 'depositRefunds', label: 'Deposit refunds', icon: CreditCard, color: 'var(--gold)', items: todos?.depositRefunds || [] },
    { key: 'onboarding', label: 'Onboarding', icon: UserPlus, color: 'var(--green)', items: todos?.onboarding || [] },
    { key: 'leases', label: 'Lease Issues', icon: FileText, color: 'var(--gold)', items: todos?.leases || [] },
    { key: 'ach', label: 'ACH Issues', icon: CreditCard, color: 'var(--amber)', items: todos?.ach || [] },
    { key: 'maintenance', label: 'High-$ Maintenance', icon: Wrench, color: 'var(--blue)', items: todos?.maintenance || [] },
    { key: 'workTrade', label: 'Work Trade', icon: HeartHandshake, color: 'var(--gold)', items: todos?.workTrade || [] },
    // 10/22 (Nic): "it says one item needs attention, but there's nothing
    // populating in the list."
    //
    // The server has always sent NINE kinds of to-do and counted all nine into
    // the total; this list rendered eight. So a park owing its home inventory
    // was counted and had nowhere to appear — a number with nothing under it.
    // It hid for as long as it did because it was one row among fifty-seven;
    // taking the fifty-six ACH rows off left it standing on its own.
    //
    // The guard below (dashboardTodoSections.test) now fails if the server ever
    // counts a kind this list does not render.
    { key: 'homeInventory', label: 'Record the homes', icon: Home, color: 'var(--blue)', items: todos?.homeInventory || [] },
  ]

  return (
    <div className="card mt-16">
      <div className="card-header">
        <span className="card-title">To-Do</span>
        <span style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
          {counts.total} item{counts.total === 1 ? '' : 's'} need{counts.total === 1 ? 's' : ''} attention
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 8 }}>
        {sections.map(section => {
          if (section.items.length === 0) return null
          const isExpanded = expanded[section.key as keyof typeof expanded]
          const visible = isExpanded ? section.items : section.items.slice(0, 3)
          const Icon = section.icon

          return (
            <div key={section.key}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <Icon size={14} style={{ color: section.color }} />
                <span style={{ fontSize: '.78rem', fontWeight: 700, color: 'var(--text-1)', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                  {section.label}
                </span>
                <span style={{ fontSize: '.68rem', color: 'var(--text-3)', fontWeight: 600 }}>
                  ({section.items.length})
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {visible.map((item: any) => (
                  <div
                    key={item.id}
                    onClick={() => navigate(item.href)}
                    style={{
                      padding: '10px 12px',
                      background: 'var(--bg-2)',
                      border: '1px solid var(--border-0)',
                      borderRadius: 8,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      transition: 'border-color .12s, background .12s',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = section.color; e.currentTarget.style.background = 'var(--bg-3)' }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-0)'; e.currentTarget.style.background = 'var(--bg-2)' }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '.82rem', fontWeight: 600, color: 'var(--text-0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.title}
                      </div>
                      <div style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.subtitle}
                      </div>
                    </div>
                    <ChevronRight size={14} style={{ color: 'var(--text-3)', flexShrink: 0 }} />
                  </div>
                ))}
              </div>

              {section.items.length > 3 && (
                <button
                  onClick={() => setExpanded(e => ({ ...e, [section.key]: !isExpanded }))}
                  style={{
                    marginTop: 6,
                    padding: '4px 8px',
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-3)',
                    fontSize: '.72rem',
                    cursor: 'pointer',
                    fontWeight: 600,
                  }}
                >
                  {isExpanded ? 'Show less' : `Show all ${section.items.length}`}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PmCutThisMonthCard() {
  const navigate = useNavigate()
  // The viewer's calendar, never toISOString (UTC): at 8 pm on Oct 3 in
  // Arizona, "the 1st" built that way is Oct 2 and today is Oct 4, so the
  // card would leave out the 1st, the day most rent settles.
  const { monthStart, today } = monthToDate()

  const { data } = useQuery<{ rows: Array<{
    propertyId: string; propertyName: string; pmCompanyId: string | null;
    pmCompanyName: string | null; pmCompanyCut: string; ownerNet: string;
  }>; from: string | null; to: string | null }>(
    ['pm-impact-mtd', monthStart, today],
    () => apiGet(`/landlords/me/pm-impact?from=${monthStart}&to=${today}`),
    { staleTime: 5 * 60 * 1000 },
  )

  if (!data || data.rows.length === 0) return null

  const totals = data.rows.reduce((acc, r) => {
    acc.cut    += Number(r.pmCompanyCut) || 0
    acc.net    += Number(r.ownerNet) || 0
    if (r.pmCompanyId) acc.linkedProps += 1
    return acc
  }, { cut: 0, net: 0, linkedProps: 0 })

  if (totals.cut === 0 && totals.linkedProps === 0) return null

  return (
    <div className="card" style={{ marginBottom: 20, cursor: 'pointer', background: 'rgba(201,162,39,.04)', border: '1px solid rgba(201,162,39,.2)' }}
         onClick={() => navigate('/disbursements')}>
      <div className="card-header">
        <span className="card-title">PM Cut This Month</span>
        <span style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>
          across {totals.linkedProps} {totals.linkedProps === 1 ? 'property' : 'properties'}
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <div>
          <div className="kpi-label">PM Cut</div>
          <div className="kpi-value gold">{fmtWhole(totals.cut)}</div>
          <div className="kpi-sub">routed to your PM company</div>
        </div>
        <div>
          <div className="kpi-label">Net to You</div>
          <div className="kpi-value green">{fmtWhole(totals.net)}</div>
          <div className="kpi-sub">owner share after PM + GAM fees</div>
        </div>
      </div>
    </div>
  )
}
// Property Health — an animated ECG/"heartbeat monitor". Each of the last 6
// months is one PQRST beat; the R-spike height scales with the money received
// that month relative to the strongest month (0 → flatline). A sweeping
// scan bar + glow give the live-monitor feel. Falls back to a static trace
// when the viewer prefers reduced motion.
//
// S655 (decision #4): under the trace, this month's income by category — the
// SAME totals the property report shows for the same month. 10/12 (Nic):
// Charged, Received and Owed side by side.
function PropertyHealthMonitor({ months, health, thisMonth, stale }: {
  months: { month: string; revenue: number; rentRevenue?: number; otherRevenue?: number }[]
  /** 10/17: this month's rent bills, invoiced against paid (see DashStats.rentHealth). */
  health?: RentHealthData
  thisMonth?: DashStats['propertyHealth']
  /** The last answer, still up while a new property loads: dimmed, like the KPI grid. */
  stale?: boolean
}) {
  const W = 640, H = 190
  const data = months.length ? months : Array.from({ length: 6 }, () => ({ month: '', revenue: 0 }))
  const vals = data.map(m => Math.max(0, Number(m.revenue) || 0))
  const max = Math.max(1, ...vals)
  const baseY = H * 0.62
  const spk = H * 0.40           // max R-spike height
  const bw = W / data.length     // beat width

  // Build the ECG polyline: per month, a flat baseline with a PQRST complex
  // whose amplitude `a` is that month's collection ÷ the strongest month.
  const pts: [number, number][] = [[0, baseY]]
  data.forEach((_, i) => {
    const x0 = i * bw
    const a = vals[i] / max
    const at = (f: number) => x0 + f * bw
    const y = (up: number) => baseY - up * spk * a   // up>0 = above baseline
    pts.push(
      [at(0.30), baseY],
      [at(0.36), y(0.08)], [at(0.42), baseY],        // P wave
      [at(0.48), y(-0.10)],                          // Q
      [at(0.53), y(1.0)],                            // R spike
      [at(0.58), y(-0.22)],                          // S
      [at(0.63), baseY],
      [at(0.76), y(0.20)], [at(0.86), baseY],        // T wave
      [at(1.0), baseY],
    )
  })
  const dPath = 'M ' + pts.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' L ')

  // Health = how much of THIS MONTH'S RENT BILLS is paid. S655: read off the
  // bills, not the contracted rent roll — "is rent getting paid" is a question
  // about the bills. 10/17 (Nic): "the property health matches what was
  // invoiced and what was paid. work trade isnt billed until a shortfall so it
  // shouldnt apply here unless an invoice generates." So it divides paid by
  // invoiced — rent on hold for work trade out of both sides, and a bill paid once
  // settled whatever settled it (money, money still clearing at the bank, an
  // account credit, money paid ahead) — instead of the Money billed figures,
  // which read held rent as owed and credit-paid rent as unpaid. Red → green →
  // gold (no amber — it'd read as the gold at a glance).
  const rate = rentBillsPaidRate(health)
  const hs = healthStatus(rate)
  // 10/18 (Nic): the same two figures the percentage divides, as the figures
  // and the subtraction under the meter — one helper, so the meter and the
  // numbers beneath it cannot come apart. The meter reads its percentage off
  // the same block rather than rounding the rate a second time.
  const healthFigs = rentHealthFigures(health, fmt)
  const status = {
    label: HEALTH_STATUS_LABEL[hs],
    color: hs === 'full' ? 'var(--gold)' : hs === 'healthy' ? 'var(--green)' : hs === 'attention' ? 'var(--red)' : 'var(--text-3)',
  }
  const cats = activeCategories(thisMonth?.categories)
  const otherLines = thisMonth?.lines ?? []
  const three = (c: CategoryRow) => categoryThree(c)
  const catTotals = sumThree(cats.map(three))

  // Hover: map the cursor to a month and surface that beat's details.
  const peaks = data.map((_, i) => ({ x: (i + 0.53) * bw, y: baseY - spk * (vals[i] / max) }))
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const onMove = (e: React.MouseEvent) => {
    const el = screenRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const f = (e.clientX - r.left) / r.width
    setHoverIdx(Math.max(0, Math.min(data.length - 1, Math.floor(f * data.length))))
  }

  return (
    <div className="card" style={{ opacity: stale ? 0.55 : 1, transition: 'opacity .15s' }} aria-busy={stale || undefined}>
      <div className="card-header">
        <span className="card-title">Property Health — last 6 months</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '.72rem', fontWeight: 700, color: status.color }}>
          <Activity size={15} /> {status.label}
        </span>
      </div>
      <div className="phm-screen" ref={screenRef} onMouseMove={onMove} onMouseLeave={() => setHoverIdx(null)}>
        {hoverIdx == null ? (
          <div className="phm-readout">
            <span className="phm-readout-label">rent bills paid · this month</span>
            <span className="phm-readout-value" style={{ color: status.color }}>{healthFigs ? `${healthFigs.pct}%` : '—'}</span>
          </div>
        ) : (
          <div className="phm-tip" style={{ left: `clamp(62px, ${((hoverIdx + 0.53) / data.length) * 100}%, calc(100% - 62px))` }}>
            {/* S639 (Nic): "when I hover over September's spike it says
                $8,915.95, but the KPI card only shows $8,020. That's a nine
                hundred dollar difference, and I'm trying to figure out why."
                Both were right — this line is ALL money collected, the card is
                rent only, and the $895.95 was utilities. Neither said which, so
                the two numbers just looked broken. This one says. */}
            <div className="phm-tip-month">{data[hoverIdx].month || '—'}</div>
            <div className="phm-tip-val" style={{ color: status.color }}>{fmt(vals[hoverIdx])}</div>
            {(data[hoverIdx] as any).otherRevenue ? (
              <div className="phm-tip-sub">
                {fmt((data[hoverIdx] as any).rentRevenue)} lot/space rent
                {' + '}{fmt((data[hoverIdx] as any).otherRevenue)} everything else
              </div>
            ) : (
              <div className="phm-tip-sub">money received · {Math.round((vals[hoverIdx] / max) * 100)}% of peak</div>
            )}
          </div>
        )}
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={190} preserveAspectRatio="none"
             role="img" aria-label={`Rent collection health, last 6 months: ${status.label}`}>
          <defs>
            <linearGradient id="phm-sweep-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%"   stopColor={status.color} stopOpacity="0" />
              <stop offset="72%"  stopColor={status.color} stopOpacity="0.08" />
              <stop offset="100%" stopColor={status.color} stopOpacity="0.30" />
            </linearGradient>
          </defs>
          <g className="phm-grid">
            {Array.from({ length: data.length + 1 }, (_, i) => <line key={'v' + i} x1={i * bw} y1={0} x2={i * bw} y2={H} />)}
            {Array.from({ length: 5 }, (_, i) => <line key={'h' + i} x1={0} y1={i * H / 4} x2={W} y2={i * H / 4} />)}
          </g>
          <line x1={0} y1={baseY} x2={W} y2={baseY} className="phm-base" />
          <path d={dPath} className="phm-trace" style={{ stroke: status.color }} fill="none" />
          <g className="phm-sweepwrap">
            <rect x={0} y={0} width={100} height={H} fill="url(#phm-sweep-grad)" />
          </g>
          {hoverIdx != null && (
            <g style={{ color: status.color }}>
              <line className="phm-hoverline" x1={(hoverIdx + 0.53) * bw} y1={0} x2={(hoverIdx + 0.53) * bw} y2={H} />
              <circle className="phm-hoverdot" cx={peaks[hoverIdx].x} cy={peaks[hoverIdx].y} r={4.5} />
            </g>
          )}
        </svg>
        <div className="phm-months">
          {data.map((m, i) => <span key={i}>{m.month}</span>)}
        </div>
      </div>
      {/* 10/18 (Nic): "we're showing only 19,483 for October versus 20,298 for
          September. I have had more people come in this month and pay this
          month than last month." Both figures are the money that ARRIVED that
          month, every kind — October really is lower, because work-trade rent
          never arrives as money, $1,415 is still owed, and money paid in late
          September for October's bills counted in September. The beats said
          none of that while a rent percentage sat on top of them, so the trace
          says what it is. */}
      <div className="phm-trace-note">{HEALTH_TRACE_NOTE}</div>
      {/* ── 10/18 (Nic): THE THREE FIGURES UNDER THE METER TIE ─────────────
          "$26,211.02 minus the received calculation of 19,483.98 in no way
           close equals 9,683.87. You're pulling numbers from different spots
           here. So that is a huge problem for a landlord to see incorrect
           numbers."
          Invoiced, paid and still owed, all three off the one helper the
          percentage divides, so the subtraction a landlord does by eye comes
          out — and it is printed, with the percentage, rather than left to be
          done. It names THIS MONTH'S RENT on purpose: the Outstanding card
          above counts every open charge of every month. Work trade is named
          without a figure — S650 keeps work-trade balances off these cards,
          and Nic's rule is only that it stays out until an invoice really
          generates. */}
      {healthFigs && (
        <div className="phm-health">
          <div className="phm-health-figs">
            {healthFigs.figures.map(f => (
              <div key={f.key}>
                <span className="phm-health-fig-label">{f.label}</span>
                <span className={`phm-health-fig-value${f.key === 'owed' && f.amount ? ' amber' : ''}`}>
                  {fmt(f.amount)}
                </span>
              </div>
            ))}
          </div>
          <div className="phm-health-note">{healthFigs.tieText} · {healthFigs.rateText}.</div>
          <div className="phm-health-note">{healthFigs.scopeNote}</div>
          {healthFigs.workTradeNote && <div className="phm-health-note">{healthFigs.workTradeNote}</div>}
        </div>
      )}
      {/* ── 10/18 (Nic): THIS TABLE SAYS WHAT IT ANSWERS ──────────────────
          The figures were right and silent. Charged is the month's bills of
          EVERY kind (work-trade-held bills included — the books charge them on
          their due day), Received is money on the day it arrived whatever month
          it was billed for, and Owed, on the books, is what tenants still owed
          at the END of the month: every bill of every month, which is why
          Mountain View reads $9,683.87 against $1,415 of October rent. Three
          figures in a row invite a subtraction, so the heading names the
          window, a line says they do not subtract, and each column carries the
          shared plain words every report prints (@gam/shared
          MONEY_COLUMN_NOTE / MONEY_COLUMN_NOTE_LEDGER — the same sentences on
          Reports, so the two pages cannot describe one column two ways). */}
      {(cats.length > 0 || otherLines.length > 0) && (
        <div className="phm-cats">
          <div className="phm-cats-title">{allMoneyHeading(thisMonth?.period)}</div>
          <div className="phm-cats-head phm-cats-three">
            <span>By category</span>
            <span>{MONEY_COLUMN_LABEL.received}</span>
            <span>{MONEY_COLUMN_LABEL.charged}</span>
            <span>{MONEY_COLUMN_LABEL.owed}</span>
          </div>
          {cats.map(c => (
            <div key={c.category} className="phm-cat-row phm-cats-three">
              <span>{categoryLabel(c)}</span>
              <span>{fmt(three(c).received)}</span>
              <span style={{ color: 'var(--text-3)' }}>{fmt(three(c).charged)}</span>
              <span style={{ color: three(c).owed ? 'var(--amber)' : 'var(--text-3)' }}>{fmt(three(c).owed)}</span>
            </div>
          ))}
          {otherLines.map(l => (
            <div key={l.line} className="phm-cat-row phm-cats-three">
              <span>{l.label}</span>
              <span>{fmt(l.amount)}</span>
              <span style={{ color: 'var(--text-3)' }}>—</span>
              <span style={{ color: 'var(--text-3)' }}>—</span>
            </div>
          ))}
          <div className="phm-cat-row total phm-cats-three">
            <span>Total</span>
            <span>{fmt(thisMonth?.total ?? 0)}</span>
            <span>{fmt(catTotals.charged)}</span>
            <span>{fmt(catTotals.owed)}</span>
          </div>
          <div className="phm-cats-notes">
            <div className="phm-health-note">{MONEY_COLUMNS_DO_NOT_SUBTRACT}</div>
            {moneyColumns(thisMonth?.source === 'ledger').map(c => (
              <div key={c.key} className="phm-health-note">
                <strong>{c.label}</strong> — {c.note}
              </div>
            ))}
          </div>
        </div>
      )}
      <style>{`
        .phm-cats-three { display: grid !important; grid-template-columns: minmax(0, 1.6fr) repeat(3, minmax(0, 1fr)); gap: 6px; }
        /* 10/18: the health block and the money table's own words. Kept here,
           beside .phm-cats-three, because they are this card's alone — the
           shared financial stylesheet (financials/reports-basis.css) is a
           by-hand copy in two apps, and a rule only the dashboard draws has no
           business being kept in sync in two places. */
        .phm-trace-note { font-size: .66rem; color: var(--text-3); margin-top: 6px; }
        .phm-health { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border-0); }
        .phm-health-figs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin-bottom: 6px; }
        .phm-health-figs > div { display: flex; flex-direction: column; min-width: 0; }
        .phm-health-fig-label { font-size: .6rem; text-transform: uppercase; letter-spacing: .06em; color: var(--text-3); font-weight: 600; }
        .phm-health-fig-value { font-family: var(--font-mono); font-size: 1.02rem; font-weight: 700; color: var(--text-0); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .phm-health-fig-value.amber { color: var(--amber); }
        .phm-cats-title { font-size: .72rem; font-weight: 700; color: var(--text-2); padding-top: 10px; border-top: 1px solid var(--border-0); }
        .phm-cats-title + .phm-cats-head { margin-top: 8px; }
        .phm-cats-notes { margin-top: 8px; display: flex; flex-direction: column; gap: 2px; }
        .phm-cats-notes strong { color: var(--text-2); font-weight: 600; }
        .dash-three { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 4px 0 2px; }
        .dash-three > div { display: flex; flex-direction: column; min-width: 0; }
        .dash-three-label { font-size: .62rem; text-transform: uppercase; letter-spacing: .06em; color: var(--text-3); font-weight: 600; }
        .dash-three-value { font-family: var(--font-mono); font-size: 1.05rem; font-weight: 700; color: var(--text-0); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .dash-three-value.green { color: var(--green); }
        .phm-screen { position: relative; background: radial-gradient(120% 90% at 50% 30%, rgba(20,26,22,.55), var(--bg-2)); border: 1px solid var(--border-0); border-radius: 10px; padding: 8px; overflow: hidden; cursor: crosshair; }
        .phm-hoverline { stroke: currentColor; stroke-width: 1; opacity: .55; stroke-dasharray: 3 3; }
        .phm-hoverdot { fill: currentColor; filter: drop-shadow(0 0 5px currentColor); }
        .phm-tip { position: absolute; top: 8px; z-index: 2; transform: translateX(-50%); background: var(--bg-3); border: 1px solid var(--border-1, var(--border-0)); border-radius: 8px; padding: 5px 10px; text-align: center; white-space: nowrap; pointer-events: none; box-shadow: 0 6px 18px rgba(0,0,0,.4); }
        .phm-tip-month { font-size: .58rem; text-transform: uppercase; letter-spacing: .07em; color: var(--text-3); }
        .phm-tip-val { font-family: var(--font-mono); font-size: .98rem; font-weight: 700; }
        .phm-tip-sub { font-size: .58rem; color: var(--text-3); margin-top: 1px; }
        .phm-grid line { stroke: var(--border-0); stroke-width: 1; opacity: .3; }
        .phm-base { stroke: var(--border-1, var(--border-0)); stroke-width: 1; opacity: .45; }
        .phm-trace { stroke-width: 2.25; stroke-linejoin: round; stroke-linecap: round; filter: drop-shadow(0 0 4px currentColor); }
        .phm-sweepwrap { opacity: 0; }
        .phm-readout { position: absolute; top: 8px; right: 12px; z-index: 1; display: flex; flex-direction: column; align-items: flex-end; line-height: 1.1; pointer-events: none; }
        .phm-readout-label { font-size: .58rem; text-transform: uppercase; letter-spacing: .08em; color: var(--text-3); }
        .phm-readout-value { font-family: var(--font-mono); font-size: 1.05rem; font-weight: 700; }
        .phm-months { display: flex; justify-content: space-around; margin-top: 4px; font-size: .66rem; color: var(--text-3); font-family: var(--font-mono); }
        @media (prefers-reduced-motion: no-preference) {
          .phm-sweepwrap { opacity: 1; animation: phm-sweep 3.4s linear infinite; }
          .phm-trace { animation: phm-glow 2.2s ease-in-out infinite; }
          @keyframes phm-sweep { from { transform: translateX(-100px); } to { transform: translateX(${W}px); } }
          @keyframes phm-glow { 0%, 100% { opacity: .82; } 50% { opacity: 1; } }
        }
      `}</style>
    </div>
  )
}
