import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { apiGet, fmt } from '../api'
import { useAuth } from '../context'

export function DashboardPage() {
  const { me } = useAuth()
  const [stats, setStats] = useState<any>(null)
  const [routines, setRoutines] = useState<any[]>([])
  const [today, setToday] = useState<any>(null)

  useEffect(() => {
    apiGet('/fitness/stats').then(setStats).catch(() => {})
    apiGet<any[]>('/fitness/routines').then(setRoutines).catch(() => {})
    apiGet('/fitness/logs/today').then(setToday).catch(() => {})
  }, [])

  const hour = new Date().getHours()
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'

  return (
    <>
      <div className="topbar">
        <div>
          <h1 style={{ fontSize: 26 }}>{greet}, {me?.firstName}</h1>
          <div className="sub">Here's where your training stands.</div>
        </div>
        <Link to="/routines" className="btn primary">Start a workout →</Link>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 18 }}>
        <Stat label="Total lifted" value={`${fmt(stats?.totalLbsLifted || 0)} lbs`} gold />
        <Stat label="Current streak" value={`${stats?.currentStreak || 0} day${stats?.currentStreak === 1 ? '' : 's'}`} />
        <Stat label="Workouts" value={fmt(stats?.totalWorkouts || 0)} />
        <Stat label="Total sets" value={fmt(stats?.totalSets || 0)} />
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3 style={{ marginBottom: 12 }}>Today</h3>
          {today && !today.completedAt ? (
            <>
              <div className="muted" style={{ marginBottom: 14 }}>You have a workout in progress: <b style={{ color: 'var(--text-0)' }}>{today.dayTitle || 'Workout'}</b></div>
              <Link to={`/workout/${today.id}`} className="btn primary">Resume workout →</Link>
            </>
          ) : today && today.completedAt ? (
            <>
              <div className="muted" style={{ marginBottom: 14 }}>✓ You crushed <b style={{ color: 'var(--text-0)' }}>{today.dayTitle || 'today\'s workout'}</b>. Nice work.</div>
              <Link to="/stats" className="btn ghost">View progress</Link>
            </>
          ) : (
            <>
              <div className="muted" style={{ marginBottom: 14 }}>No workout logged yet today.</div>
              <Link to="/routines" className="btn primary">Pick a day &amp; start →</Link>
            </>
          )}
        </div>

        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3>Your routines</h3>
            <Link to="/routines" className="muted" style={{ fontSize: 13, color: 'var(--gold)' }}>Manage →</Link>
          </div>
          {routines.length === 0 ? (
            <div className="muted">No routines yet. <Link to="/routines" style={{ color: 'var(--gold)' }}>Build your first one.</Link></div>
          ) : (
            <div className="grid" style={{ gap: 8 }}>
              {routines.slice(0, 4).map(r => (
                <Link key={r.id} to="/routines" className="card tight" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--panel-2)' }}>
                  <b>{r.name}</b>
                  <span className="pill gold">open</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

function Stat({ label, value, gold }: { label: string; value: string; gold?: boolean }) {
  return (
    <div className="card stat tight">
      <div className="label">{label}</div>
      <div className={'value' + (gold ? ' gold' : '')}>{value}</div>
    </div>
  )
}
