import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiGet, apiPost, apiDelete } from '../api'
import { useToast } from '../context'

type Exercise = { name: string; sets: string; reps_min: string; reps_max: string; notes: string }
type Section = { label: string; exercises: Exercise[] }
type Day = { title: string; subtitle: string; sections: Section[] }

const blankExercise = (): Exercise => ({ name: '', sets: '3', reps_min: '8', reps_max: '12', notes: '' })
const blankSection = (): Section => ({ label: 'Main', exercises: [blankExercise()] })
const blankDay = (): Day => ({ title: '', subtitle: '', sections: [blankSection()] })

export function RoutinesPage() {
  const [routines, setRoutines] = useState<any[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [full, setFull] = useState<Record<string, any>>({})
  const [building, setBuilding] = useState(false)
  const toast = useToast()
  const nav = useNavigate()

  const reload = () => apiGet<any[]>('/fitness/routines').then(setRoutines).catch(() => {})
  useEffect(() => { reload() }, [])

  async function open(id: string) {
    if (openId === id) { setOpenId(null); return }
    setOpenId(id)
    if (!full[id]) {
      const data = await apiGet(`/fitness/routines/${id}/full`)
      setFull(p => ({ ...p, [id]: data }))
    }
  }

  async function startDay(day: any) {
    const res = await apiPost('/fitness/logs', { day_id: day.id, day_title: day.title })
    if (res.success && res.data) nav(`/workout/${(res.data as any).id}`, { state: { day } })
    else toast(res.error || 'Could not start workout')
  }

  async function remove(id: string) {
    if (!confirm('Delete this routine? This cannot be undone.')) return
    await apiDelete(`/fitness/routines/${id}`)
    setOpenId(null)
    reload()
  }

  return (
    <>
      <div className="topbar">
        <div><h1 style={{ fontSize: 26 }}>Routines</h1><div className="sub">Build a plan, then log workouts against it.</div></div>
        {!building && <button className="btn primary" onClick={() => setBuilding(true)}>+ New routine</button>}
      </div>

      {building && <Builder onCancel={() => setBuilding(false)} onCreated={() => { setBuilding(false); reload() }} />}

      {routines.length === 0 && !building && <div className="card empty">No routines yet. Create one to get started.</div>}

      <div className="grid" style={{ gap: 12 }}>
        {routines.map(r => (
          <div key={r.id} className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div onClick={() => open(r.id)} style={{ cursor: 'pointer', flex: 1 }}>
                <b style={{ fontSize: 16 }}>{r.name}</b>
                {r.description && <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>{r.description}</div>}
              </div>
              <div className="row" style={{ gap: 8, flex: 'none' }}>
                <button className="btn sm ghost" onClick={() => open(r.id)}>{openId === r.id ? 'Hide' : 'View'}</button>
                <button className="btn sm danger" onClick={() => remove(r.id)}>Delete</button>
              </div>
            </div>

            {openId === r.id && full[r.id] && (
              <div style={{ marginTop: 16, display: 'grid', gap: 14 }}>
                {(full[r.id].days || []).map((day: any) => (
                  <div key={day.id} className="card tight" style={{ background: 'var(--panel-2)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <div><b>{day.title}</b>{day.subtitle && <span className="muted" style={{ marginLeft: 8, fontSize: 13 }}>{day.subtitle}</span>}</div>
                      <button className="btn sm primary" onClick={() => startDay(day)}>Start →</button>
                    </div>
                    {(day.sections || []).map((s: any) => (
                      <div key={s.id} style={{ marginBottom: 8 }}>
                        <div className="pill" style={{ marginBottom: 6 }}>{s.label}</div>
                        {(s.exercises || []).map((ex: any) => (
                          <div key={ex.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 14, borderBottom: '1px solid var(--border)' }}>
                            <span>{ex.name}</span>
                            <span className="muted mono">{ex.sets} × {ex.repsMin}{ex.repsMax && ex.repsMax !== ex.repsMin ? `-${ex.repsMax}` : ''}</span>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

function Builder({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [days, setDays] = useState<Day[]>([blankDay()])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const toast = useToast()

  const upd = (fn: (d: Day[]) => void) => setDays(prev => { const c = structuredClone(prev); fn(c); return c })

  async function save() {
    if (!name.trim()) { setErr('Give your routine a name'); return }
    setBusy(true); setErr('')
    const payload = {
      name, description,
      days: days.map((d, i) => ({
        day_number: i + 1, title: d.title || `Day ${i + 1}`, subtitle: d.subtitle,
        sections: d.sections.map(s => ({
          label: s.label,
          exercises: s.exercises.filter(e => e.name.trim()).map(e => ({
            name: e.name, sets: Number(e.sets) || null, reps_min: Number(e.reps_min) || null,
            reps_max: Number(e.reps_max) || null, notes: e.notes || null,
          })),
        })),
      })),
    }
    const res = await apiPost('/fitness/routines', payload)
    setBusy(false)
    if (!res.success) { setErr(res.error || 'Could not save'); return }
    toast('Routine created'); onCreated()
  }

  return (
    <div className="card" style={{ marginBottom: 18, borderColor: 'var(--gold-soft)' }}>
      <h3 style={{ marginBottom: 14 }}>New routine</h3>
      <div className="row">
        <label className="field"><span className="lbl">Name</span>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Upper / Lower Split" /></label>
        <label className="field"><span className="lbl">Description (optional)</span>
          <input value={description} onChange={e => setDescription(e.target.value)} /></label>
      </div>

      {days.map((day, di) => (
        <div key={di} className="card tight" style={{ background: 'var(--panel-2)', marginBottom: 12 }}>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <label className="field" style={{ marginBottom: 8 }}><span className="lbl">Day {di + 1} title</span>
              <input value={day.title} onChange={e => upd(d => { d[di].title = e.target.value })} placeholder="e.g. Push" /></label>
            <label className="field" style={{ marginBottom: 8 }}><span className="lbl">Subtitle</span>
              <input value={day.subtitle} onChange={e => upd(d => { d[di].subtitle = e.target.value })} placeholder="Chest, shoulders, triceps" /></label>
            {days.length > 1 && <button className="btn sm danger" style={{ marginBottom: 8 }} onClick={() => upd(d => { d.splice(di, 1) })}>Remove day</button>}
          </div>

          {day.sections.map((sec, si) => (
            <div key={si} style={{ marginTop: 8 }}>
              <label className="field" style={{ marginBottom: 8 }}><span className="lbl">Section label</span>
                <input value={sec.label} onChange={e => upd(d => { d[di].sections[si].label = e.target.value })} /></label>
              {sec.exercises.map((ex, ei) => (
                <div key={ei} className="row" style={{ marginBottom: 8, alignItems: 'flex-end' }}>
                  <label className="field" style={{ flex: 3, marginBottom: 0 }}><span className="lbl">Exercise</span>
                    <input value={ex.name} onChange={e => upd(d => { d[di].sections[si].exercises[ei].name = e.target.value })} placeholder="Bench Press" /></label>
                  <label className="field" style={{ marginBottom: 0 }}><span className="lbl">Sets</span>
                    <input value={ex.sets} onChange={e => upd(d => { d[di].sections[si].exercises[ei].sets = e.target.value })} /></label>
                  <label className="field" style={{ marginBottom: 0 }}><span className="lbl">Reps min</span>
                    <input value={ex.reps_min} onChange={e => upd(d => { d[di].sections[si].exercises[ei].reps_min = e.target.value })} /></label>
                  <label className="field" style={{ marginBottom: 0 }}><span className="lbl">Reps max</span>
                    <input value={ex.reps_max} onChange={e => upd(d => { d[di].sections[si].exercises[ei].reps_max = e.target.value })} /></label>
                  {sec.exercises.length > 1 && <button className="btn sm ghost" style={{ marginBottom: 0 }} onClick={() => upd(d => { d[di].sections[si].exercises.splice(ei, 1) })}>✕</button>}
                </div>
              ))}
              <button className="btn sm ghost" onClick={() => upd(d => { d[di].sections[si].exercises.push(blankExercise()) })}>+ Exercise</button>
            </div>
          ))}
        </div>
      ))}

      <button className="btn ghost sm" onClick={() => setDays(d => [...d, blankDay()])}>+ Add day</button>
      {err && <div className="err">{err}</div>}
      <div className="divider" />
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn ghost" style={{ flex: 'none' }} onClick={onCancel}>Cancel</button>
        <button className="btn primary" style={{ flex: 'none' }} onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save routine'}</button>
      </div>
    </div>
  )
}
