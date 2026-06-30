import { useEffect, useState } from 'react'
import { apiGet, apiPost, fmt } from '../api'
import { useToast } from '../context'

export function StatsPage() {
  const [stats, setStats] = useState<any>(null)
  const [prs, setPrs] = useState<any[]>([])
  const [bw, setBw] = useState('')
  const toast = useToast()

  const load = () => {
    apiGet('/fitness/stats').then(setStats).catch(() => {})
    apiGet<any[]>('/fitness/prs').then(setPrs).catch(() => {})
  }
  useEffect(() => { load() }, [])

  async function logBodyweight() {
    if (!bw) return
    const res = await apiPost('/fitness/bodyweight', { weight_lbs: Number(bw) })
    if (res.success) { toast('Body weight logged'); setBw(''); load() }
    else toast(res.error || 'Could not log')
  }

  const weekly: any[] = stats?.weeklyVolume || []
  const maxVol = Math.max(1, ...weekly.map(w => Number(w.volume)))
  const milestones: any[] = stats?.milestones || []
  const bwHistory: any[] = stats?.bodyWeightHistory || []

  return (
    <>
      <div className="topbar"><div><h1 style={{ fontSize: 26 }}>Progress</h1><div className="sub">Your training, measured.</div></div></div>

      <div className="grid cols-4" style={{ marginBottom: 18 }}>
        <Stat label="Total lifted" value={`${fmt(stats?.totalLbsLifted || 0)} lbs`} gold />
        <Stat label="Total reps" value={fmt(stats?.totalReps || 0)} />
        <Stat label="Total sets" value={fmt(stats?.totalSets || 0)} />
        <Stat label="Workouts" value={fmt(stats?.totalWorkouts || 0)} />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3 style={{ marginBottom: 16 }}>Weekly volume (last 12 wks)</h3>
          {weekly.length === 0 ? <div className="empty">Log some sets to see your volume trend.</div> : (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 160 }}>
              {weekly.map((w, i) => (
                <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', gap: 6 }}>
                  <div title={`${fmt(Math.round(Number(w.volume)))} lbs`}
                    style={{ width: '100%', height: `${(Number(w.volume) / maxVol) * 130}px`, minHeight: 3, background: 'linear-gradient(180deg,var(--gold),var(--gold-soft))', borderRadius: 5 }} />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 16 }}>Milestones</h3>
          {milestones.length === 0 ? <div className="empty">Lift more to unlock milestones — first one at 100,000 lbs.</div> : (
            <div className="grid" style={{ gap: 8 }}>
              {milestones.map((m, i) => (
                <div key={i} className="card tight" style={{ background: 'var(--panel-2)', display: 'flex', justifyContent: 'space-between' }}>
                  <b className="gold" style={{ color: 'var(--gold)' }}>🏅 {fmt(parseInt(String(m.milestoneType).replace('_lbs', '')))} lbs</b>
                  <span className="muted" style={{ fontSize: 13 }}>{m.achievedAt ? new Date(m.achievedAt).toLocaleDateString() : ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 18 }}>
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>Personal records</h3>
          {prs.length === 0 ? <div className="empty">No PRs yet.</div> : (
            <table>
              <thead><tr><th>Exercise</th><th>Best</th><th>Sets</th></tr></thead>
              <tbody>{prs.map((p, i) => (
                <tr key={i}><td>{p.exerciseName}</td><td className="mono gold" style={{ color: 'var(--gold)' }}>{fmt(Number(p.prWeight))} lbs</td><td className="mono muted">{p.totalSets}</td></tr>
              ))}</tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h3 style={{ marginBottom: 12 }}>Body weight</h3>
          <div className="row" style={{ alignItems: 'flex-end', marginBottom: 14 }}>
            <label className="field" style={{ marginBottom: 0 }}><span className="lbl">Log today (lbs)</span>
              <input value={bw} onChange={e => setBw(e.target.value)} placeholder="185" /></label>
            <button className="btn primary" style={{ flex: 'none' }} onClick={logBodyweight}>Log</button>
          </div>
          {bwHistory.length === 0 ? <div className="muted" style={{ fontSize: 13 }}>No entries yet.</div> : (
            <div style={{ maxHeight: 160, overflow: 'auto' }}>
              <table><tbody>
                {bwHistory.map((b, i) => (
                  <tr key={i}><td>{new Date(b.loggedDate).toLocaleDateString()}</td><td className="mono" style={{ textAlign: 'right' }}>{fmt(Number(b.weightLbs))} lbs</td></tr>
                ))}
              </tbody></table>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function Stat({ label, value, gold }: { label: string; value: string; gold?: boolean }) {
  return <div className="card stat tight"><div className="label">{label}</div><div className={'value' + (gold ? ' gold' : '')}>{value}</div></div>
}
