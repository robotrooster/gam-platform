import { useEffect, useState } from 'react'
import { useParams, useLocation, useNavigate } from 'react-router-dom'
import { apiGet, apiPost, apiPatch, fmt } from '../api'
import { useToast } from '../context'

const MILESTONES = [100000, 500000, 1000000, 5000000, 10000000, 50000000, 100000000, 500000000, 1000000000]

type PlannedExercise = { id?: string; name: string; repsMin?: number; repsMax?: number; sets?: number }

export function WorkoutPage() {
  const { logId } = useParams()
  const loc = useLocation()
  const nav = useNavigate()
  const toast = useToast()

  const day = (loc.state as any)?.day || null
  const planned: PlannedExercise[] = day
    ? (day.sections || []).flatMap((s: any) => (s.exercises || []))
    : []

  const [sets, setSets] = useState<any[]>([])
  const [allTime, setAllTime] = useState<number | null>(null)
  const [minutes, setMinutes] = useState('')
  const [free, setFree] = useState({ name: '', weight: '', reps: '' })

  const reloadSets = () => apiGet<any[]>(`/fitness/sets/${logId}`).then(setSets).catch(() => {})
  useEffect(() => { reloadSets() }, [logId])

  const workoutVolume = sets.reduce((acc, s) => acc + (Number(s.weightLbs) || 0) * (Number(s.reps) || 0), 0)

  async function logSet(exercise_name: string, exercise_id: string | undefined, weight: string, reps: string) {
    if (!exercise_name.trim()) { toast('Pick an exercise'); return }
    const res = await apiPost('/fitness/sets', {
      log_id: logId, exercise_id: exercise_id || null, exercise_name,
      weight_lbs: Number(weight) || 0, reps: Number(reps) || 0,
    })
    if (!res.success) { toast(res.error || 'Could not log set'); return }
    const newTotal = (res as any).totalLbs as number
    if (allTime != null) {
      const crossed = MILESTONES.find(m => allTime < m && newTotal >= m)
      if (crossed) toast(`🎉 Milestone: ${fmt(crossed)} lbs lifted!`)
    }
    setAllTime(newTotal)
    reloadSets()
  }

  async function finish() {
    await apiPatch(`/fitness/logs/${logId}/complete`, { duration_minutes: Number(minutes) || null })
    toast('Workout logged 💪')
    nav('/stats')
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1 style={{ fontSize: 26 }}>{day?.title || 'Workout'}</h1>
          <div className="sub">{day?.subtitle || 'Log your sets as you go.'}</div>
        </div>
        <div className="card stat tight" style={{ minWidth: 180 }}>
          <div className="label">This workout</div>
          <div className="value gold">{fmt(Math.round(workoutVolume))} lbs</div>
        </div>
      </div>

      <div className="grid cols-2">
        <div>
          <h3 style={{ marginBottom: 12 }}>{planned.length ? "Today's exercises" : 'Log a set'}</h3>
          {planned.length > 0 && (
            <div className="grid" style={{ gap: 10, marginBottom: 16 }}>
              {planned.map((ex, i) => <PlannedRow key={i} ex={ex} onLog={(w, r) => logSet(ex.name, ex.id, w, r)} count={sets.filter(s => s.exerciseName === ex.name).length} />)}
            </div>
          )}

          <div className="card" style={{ background: 'var(--panel-2)' }}>
            <div className="lbl" style={{ color: 'var(--text-1)', fontSize: 13, marginBottom: 8 }}>{planned.length ? 'Add another exercise' : 'Exercise'}</div>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <label className="field" style={{ flex: 3, marginBottom: 0 }}><span className="lbl">Name</span>
                <input value={free.name} onChange={e => setFree({ ...free, name: e.target.value })} placeholder="Deadlift" /></label>
              <label className="field" style={{ marginBottom: 0 }}><span className="lbl">Weight</span>
                <input value={free.weight} onChange={e => setFree({ ...free, weight: e.target.value })} /></label>
              <label className="field" style={{ marginBottom: 0 }}><span className="lbl">Reps</span>
                <input value={free.reps} onChange={e => setFree({ ...free, reps: e.target.value })} /></label>
            </div>
            <button className="btn primary sm" style={{ marginTop: 10 }}
              onClick={() => { logSet(free.name, undefined, free.weight, free.reps); setFree({ name: '', weight: '', reps: '' }) }}>
              + Log set
            </button>
          </div>
        </div>

        <div>
          <h3 style={{ marginBottom: 12 }}>Logged sets ({sets.length})</h3>
          <div className="card" style={{ padding: 0 }}>
            {sets.length === 0 ? <div className="empty">No sets logged yet.</div> : (
              <table>
                <thead><tr><th>Exercise</th><th>Weight</th><th>Reps</th><th>Vol</th></tr></thead>
                <tbody>
                  {sets.map(s => (
                    <tr key={s.id}>
                      <td>{s.exerciseName}</td>
                      <td className="mono">{fmt(Number(s.weightLbs))}</td>
                      <td className="mono">{s.reps}</td>
                      <td className="mono muted">{fmt(Math.round(Number(s.weightLbs) * s.reps))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card" style={{ marginTop: 14 }}>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <label className="field" style={{ marginBottom: 0 }}><span className="lbl">Duration (min)</span>
                <input value={minutes} onChange={e => setMinutes(e.target.value)} placeholder="optional" /></label>
              <button className="btn primary" style={{ flex: 'none' }} onClick={finish}>Finish workout ✓</button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function PlannedRow({ ex, onLog, count }: { ex: PlannedExercise; onLog: (w: string, r: string) => void; count: number }) {
  const [w, setW] = useState('')
  const [r, setR] = useState('')
  const target = ex.repsMin ? `${ex.sets || ''}×${ex.repsMin}${ex.repsMax && ex.repsMax !== ex.repsMin ? `-${ex.repsMax}` : ''}` : ''
  return (
    <div className="card tight" style={{ background: 'var(--panel-2)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <b>{ex.name} {target && <span className="muted mono" style={{ fontSize: 13, fontWeight: 400 }}>· {target}</span>}</b>
        {count > 0 && <span className="pill gold">{count} set{count === 1 ? '' : 's'}</span>}
      </div>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <label className="field" style={{ marginBottom: 0 }}><span className="lbl">Weight</span>
          <input value={w} onChange={e => setW(e.target.value)} /></label>
        <label className="field" style={{ marginBottom: 0 }}><span className="lbl">Reps</span>
          <input value={r} onChange={e => setR(e.target.value)} /></label>
        <button className="btn sm" style={{ flex: 'none' }} onClick={() => { onLog(w, r); setR('') }}>Log</button>
      </div>
    </div>
  )
}
