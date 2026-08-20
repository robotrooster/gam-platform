/**
 * S609 (Nic): the platform's rent volume as a heartbeat monitor.
 *
 * "I would like to also change that to the same heartbeat monitor that we have
 * in the other portals, just huge spikes. Like, if we get massive tenants
 * onboarding one month, I want it to just see a huge spike that just dwarfs the
 * other spikes."
 *
 * Each month is one ECG beat and the R-spike scales against the STRONGEST month
 * in the window, so a big month towers over the rest and a dead month flatlines.
 * That relative scaling is the whole point — an absolute axis would flatten
 * exactly the difference he wants to see at a glance.
 *
 * WHAT IT REPLACED: a hardcoded array of five invented numbers with one real
 * value on the end, drawing a tidy upward line regardless of what the platform
 * actually did. See GET /api/admin/rent-volume-trend.
 *
 * SAME VISUAL LANGUAGE as PropertyHealthMonitor on the landlord dashboard
 * (apps/landlord/src/pages/DashboardPage.tsx), deliberately — an operator moving
 * between portals should read the same shape the same way. It is a separate
 * component rather than a shared one because there is no shared UI package, and
 * `packages/shared` is plain TypeScript that the API also imports — putting
 * React in there would pull it into the backend. If you change the trace here,
 * change it there too.
 *
 * NOTE the CSS variables differ between the two apps (admin uses --bg2/--t3/--b1
 * and --font-m; landlord uses --bg-2/--text-3/--font-mono). Copying the landlord
 * styles verbatim would render this unstyled.
 */

import { useRef, useState } from 'react'
import { Activity } from 'lucide-react'

export interface TrendPoint {
  /** First day of the month, ISO. Used for the unambiguous hover label. */
  monthStart: string
  /** Short month name, e.g. 'Aug'. */
  label: string
  /** Rent that actually settled that month. */
  revenue: number
}

const fmt = (n: number) =>
  n >= 1000
    ? `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`
    : `$${n.toFixed(0)}`

const fullMonth = (iso: string) => {
  const m = /^(\d{4})-(\d{2})/.exec(iso)
  if (!m) return iso
  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December']
  return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`
}

export function RentVolumeMonitor({ months, windowMonths, onWindowChange }: {
  months: TrendPoint[]
  windowMonths: number
  onWindowChange: (n: number) => void
}) {
  const W = 640, H = 190
  const data = months.length
    ? months
    : Array.from({ length: windowMonths }, () => ({ monthStart: '', label: '', revenue: 0 }))
  const vals = data.map(m => Math.max(0, Number(m.revenue) || 0))
  const max = Math.max(1, ...vals)
  const total = vals.reduce((s, v) => s + v, 0)
  const baseY = H * 0.62
  const spk = H * 0.40           // max R-spike height
  const bw = W / data.length     // beat width

  // The ECG polyline: per month a flat baseline with a PQRST complex whose
  // amplitude is that month's volume ÷ the strongest month. Zero → flatline.
  const pts: [number, number][] = [[0, baseY]]
  data.forEach((_, i) => {
    const x0 = i * bw
    const a = vals[i] / max
    const at = (f: number) => x0 + f * bw
    const y = (up: number) => baseY - up * spk * a
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

  // The colour reads MOMENTUM, not health: this month against the average of
  // the ones before it. A platform-wide total has no "expected" to measure
  // against the way one property's rent roll does, so inventing a target would
  // be a made-up number on a dashboard that just had one removed.
  const current = vals[vals.length - 1] ?? 0
  const prior = vals.slice(0, -1)
  const priorAvg = prior.length ? prior.reduce((s, v) => s + v, 0) / prior.length : 0
  const trend = priorAvg > 0 ? current / priorAvg : null
  const status = total === 0
    ? { label: 'No volume yet', color: 'var(--t3)' }
    : trend == null   ? { label: 'First month',  color: 'var(--gold)' }
    : trend >= 1.25   ? { label: 'Spiking',      color: 'var(--gold)' }
    : trend >= 0.9    ? { label: 'Steady',       color: 'var(--green)' }
    :                   { label: 'Down on average', color: 'var(--red)' }

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

  // Long windows can't show a label per month without turning to mush.
  const labelEvery = data.length > 18 ? 6 : data.length > 12 ? 3 : 1

  return (
    <div className="card">
      <div className="ct" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span>Rent Collected</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '.72rem', fontWeight: 700, color: status.color }}>
          <Activity size={15} /> {status.label}
        </span>
        {/* S609 (Nic): "eventually maybe be able to print it out like a polygraph
            test over time, like a whole history for the last, like, three years."
            The window is a control rather than a constant so the long view is
            already here; 36 months is the server's cap. */}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 4 }}>
          {[6, 12, 24, 36].map(n => (
            <button key={n}
              onClick={() => onWindowChange(n)}
              style={{
                background: n === windowMonths ? 'var(--bg4)' : 'transparent',
                border: '1px solid var(--b1)', borderRadius: 6, cursor: 'pointer',
                color: n === windowMonths ? 'var(--t0)' : 'var(--t3)',
                fontSize: '.66rem', padding: '2px 7px', fontWeight: 600,
              }}>
              {n >= 12 ? `${n / 12}y` : `${n}m`}
            </button>
          ))}
        </span>
      </div>

      <div className="rvm-screen" ref={screenRef} onMouseMove={onMove} onMouseLeave={() => setHoverIdx(null)}>
        {hoverIdx == null ? (
          <div className="rvm-readout">
            <span className="rvm-readout-label">collected · this month</span>
            <span className="rvm-readout-value" style={{ color: status.color }}>{fmt(current)}</span>
          </div>
        ) : (
          <div className="rvm-tip" style={{ left: `clamp(70px, ${((hoverIdx + 0.53) / data.length) * 100}%, calc(100% - 70px))` }}>
            <div className="rvm-tip-month">
              {data[hoverIdx].monthStart ? fullMonth(data[hoverIdx].monthStart) : '—'}
            </div>
            <div className="rvm-tip-val" style={{ color: status.color }}>{fmt(vals[hoverIdx])}</div>
            <div className="rvm-tip-sub">
              {vals[hoverIdx] === 0 ? 'nothing collected' : `${Math.round((vals[hoverIdx] / max) * 100)}% of peak`}
            </div>
          </div>
        )}
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={190} preserveAspectRatio="none"
             role="img" aria-label={`Rent collected over the last ${data.length} months: ${status.label}`}>
          <defs>
            <linearGradient id="rvm-sweep-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%"   stopColor={status.color} stopOpacity="0" />
              <stop offset="72%"  stopColor={status.color} stopOpacity="0.08" />
              <stop offset="100%" stopColor={status.color} stopOpacity="0.30" />
            </linearGradient>
          </defs>
          <g className="rvm-grid">
            {Array.from({ length: data.length + 1 }, (_, i) => <line key={'v' + i} x1={i * bw} y1={0} x2={i * bw} y2={H} />)}
            {Array.from({ length: 5 }, (_, i) => <line key={'h' + i} x1={0} y1={i * H / 4} x2={W} y2={i * H / 4} />)}
          </g>
          <line x1={0} y1={baseY} x2={W} y2={baseY} className="rvm-base" />
          <path d={dPath} className="rvm-trace" style={{ stroke: status.color }} fill="none" />
          <g className="rvm-sweepwrap">
            <rect x={0} y={0} width={100} height={H} fill="url(#rvm-sweep-grad)" />
          </g>
          {hoverIdx != null && (
            <g style={{ color: status.color }}>
              <line className="rvm-hoverline" x1={(hoverIdx + 0.53) * bw} y1={0} x2={(hoverIdx + 0.53) * bw} y2={H} />
              <circle className="rvm-hoverdot" cx={peaks[hoverIdx].x} cy={peaks[hoverIdx].y} r={4.5} />
            </g>
          )}
        </svg>
        <div className="rvm-months">
          {data.map((m, i) => (
            <span key={i}>{i % labelEvery === 0 || i === data.length - 1 ? m.label : ''}</span>
          ))}
        </div>
      </div>

      <div style={{ fontSize: '.66rem', color: 'var(--t3)', marginTop: 8, lineHeight: 1.5 }}>
        Rent, utilities and fees that actually settled, by the month the money moved. Each beat is
        one month; spike height is that month against the strongest in view, so a big month towers
        and a dead month flatlines. Contracted rent is the KPI above — this is what came in.
      </div>

      <style>{`
        .rvm-screen { position: relative; background: radial-gradient(120% 90% at 50% 30%, rgba(20,26,22,.55), var(--bg2)); border: 1px solid var(--b1); border-radius: 10px; padding: 8px; overflow: hidden; cursor: crosshair; }
        .rvm-hoverline { stroke: currentColor; stroke-width: 1; opacity: .55; stroke-dasharray: 3 3; }
        .rvm-hoverdot { fill: currentColor; filter: drop-shadow(0 0 5px currentColor); }
        .rvm-tip { position: absolute; top: 8px; z-index: 2; transform: translateX(-50%); background: var(--bg3); border: 1px solid var(--b2); border-radius: 8px; padding: 5px 10px; text-align: center; white-space: nowrap; pointer-events: none; box-shadow: 0 6px 18px rgba(0,0,0,.4); }
        .rvm-tip-month { font-size: .58rem; text-transform: uppercase; letter-spacing: .07em; color: var(--t3); }
        .rvm-tip-val { font-family: var(--font-m); font-size: .98rem; font-weight: 700; }
        .rvm-tip-sub { font-size: .58rem; color: var(--t3); margin-top: 1px; }
        .rvm-grid line { stroke: var(--b1); stroke-width: 1; opacity: .3; }
        .rvm-base { stroke: var(--b2); stroke-width: 1; opacity: .45; }
        .rvm-trace { stroke-width: 2.25; stroke-linejoin: round; stroke-linecap: round; filter: drop-shadow(0 0 4px currentColor); }
        .rvm-sweepwrap { opacity: 0; }
        .rvm-readout { position: absolute; top: 8px; right: 12px; z-index: 1; display: flex; flex-direction: column; align-items: flex-end; line-height: 1.1; pointer-events: none; }
        .rvm-readout-label { font-size: .58rem; text-transform: uppercase; letter-spacing: .08em; color: var(--t3); }
        .rvm-readout-value { font-family: var(--font-m); font-size: 1.05rem; font-weight: 700; }
        .rvm-months { display: flex; justify-content: space-around; margin-top: 4px; font-size: .66rem; color: var(--t3); font-family: var(--font-m); }
        @media (prefers-reduced-motion: no-preference) {
          .rvm-sweepwrap { opacity: 1; animation: rvm-sweep 3.4s linear infinite; }
          .rvm-trace { animation: rvm-glow 2.2s ease-in-out infinite; }
          @keyframes rvm-sweep { from { transform: translateX(-100px); } to { transform: translateX(${W}px); } }
          @keyframes rvm-glow { 0%, 100% { opacity: .82; } 50% { opacity: 1; } }
        }
      `}</style>
    </div>
  )
}
