import React, { useState } from 'react'
import { apiPost } from '../api'

const GOALS = [
  { v: 'recomp', label: 'Recomp', desc: 'Build muscle, lose fat' },
  { v: 'bulk', label: 'Bulk', desc: 'Add size & strength' },
  { v: 'cut', label: 'Cut', desc: 'Lean out' },
  { v: 'athletic', label: 'Athletic', desc: 'Performance & conditioning' },
]
const LEVELS = ['beginner', 'intermediate', 'advanced']

export function OnboardingPage({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState<any>({ fitness_goal: 'recomp', experience_level: 'beginner', days_per_week: 4, minutes_per_session: 60 })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }))

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setErr('')
    const res = await apiPost('/fitness/profile', {
      height_inches: f.height_inches ? Number(f.height_inches) : null,
      weight_lbs: f.weight_lbs ? Number(f.weight_lbs) : null,
      age: f.age ? Number(f.age) : null,
      target_weight_lbs: f.target_weight_lbs ? Number(f.target_weight_lbs) : null,
      fitness_goal: f.fitness_goal,
      experience_level: f.experience_level,
      days_per_week: Number(f.days_per_week),
      minutes_per_session: Number(f.minutes_per_session),
      onboarding_complete: true,
    })
    if (!res.success) { setErr(res.error || 'Could not save'); setBusy(false); return }
    onDone()
  }

  return (
    <div className="center">
      <div style={{ width: '100%', maxWidth: 560 }}>
        <h1 style={{ fontSize: 26, marginBottom: 6 }}>Let's set up your training</h1>
        <div className="muted" style={{ marginBottom: 22 }}>A few details so we can track progress against your goal.</div>
        <form onSubmit={submit} className="card">
          <span className="lbl" style={{ color: 'var(--text-1)', fontSize: 13, display: 'block', marginBottom: 8 }}>Your goal</span>
          <div className="grid cols-2" style={{ marginBottom: 18 }}>
            {GOALS.map(g => (
              <div key={g.v} onClick={() => set('fitness_goal', g.v)}
                className="card tight" style={{ cursor: 'pointer', borderColor: f.fitness_goal === g.v ? 'var(--gold)' : 'var(--border)', background: f.fitness_goal === g.v ? 'var(--gold-dim)' : 'var(--panel-2)' }}>
                <b style={{ color: f.fitness_goal === g.v ? 'var(--gold)' : 'var(--text-0)' }}>{g.label}</b>
                <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>{g.desc}</div>
              </div>
            ))}
          </div>

          <label className="field"><span className="lbl">Experience</span>
            <select value={f.experience_level} onChange={e => set('experience_level', e.target.value)}>
              {LEVELS.map(l => <option key={l} value={l}>{l[0].toUpperCase() + l.slice(1)}</option>)}
            </select></label>

          <div className="row">
            <label className="field"><span className="lbl">Age</span>
              <input type="number" value={f.age || ''} onChange={e => set('age', e.target.value)} /></label>
            <label className="field"><span className="lbl">Height (in)</span>
              <input type="number" value={f.height_inches || ''} onChange={e => set('height_inches', e.target.value)} /></label>
          </div>
          <div className="row">
            <label className="field"><span className="lbl">Weight (lbs)</span>
              <input type="number" value={f.weight_lbs || ''} onChange={e => set('weight_lbs', e.target.value)} /></label>
            <label className="field"><span className="lbl">Target weight (lbs)</span>
              <input type="number" value={f.target_weight_lbs || ''} onChange={e => set('target_weight_lbs', e.target.value)} /></label>
          </div>
          <div className="row">
            <label className="field"><span className="lbl">Days / week</span>
              <input type="number" min={1} max={7} value={f.days_per_week} onChange={e => set('days_per_week', e.target.value)} /></label>
            <label className="field"><span className="lbl">Minutes / session</span>
              <input type="number" min={10} max={240} value={f.minutes_per_session} onChange={e => set('minutes_per_session', e.target.value)} /></label>
          </div>

          {err && <div className="err">{err}</div>}
          <button className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} disabled={busy}>
            {busy ? 'Saving…' : 'Start training →'}
          </button>
        </form>
      </div>
    </div>
  )
}
