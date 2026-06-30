import { useEffect, useState } from 'react'
import { apiGet, fmt } from '../api'

export function LeaderboardPage() {
  const [data, setData] = useState<any>(null)
  useEffect(() => { apiGet('/fitness/leaderboard').then(setData).catch(() => {}) }, [])

  const top: any[] = data?.top || []
  const me = data?.me

  return (
    <>
      <div className="topbar">
        <div><h1 style={{ fontSize: 26 }}>Leaderboard</h1><div className="sub">Platform-wide — every GAM Fitness lifter, ranked by total volume.</div></div>
      </div>

      {me && (
        <div className="card" style={{ marginBottom: 18, borderColor: 'var(--gold-soft)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div><span className="muted">Your rank</span> <b className="rank" style={{ fontSize: 22, marginLeft: 8 }}>#{me.rank}</b></div>
          <div className="mono gold" style={{ color: 'var(--gold)', fontWeight: 700 }}>{fmt(Math.round(me.totalLbs))} lbs</div>
        </div>
      )}

      <div className="card" style={{ padding: 0 }}>
        {top.length === 0 ? <div className="empty">No lifters on the board yet. Log a workout to claim #1.</div> : (
          <table>
            <thead><tr><th style={{ width: 60 }}>Rank</th><th>Lifter</th><th>Total volume</th><th>Workouts</th></tr></thead>
            <tbody>
              {top.map(r => (
                <tr key={r.userId} className={r.isMe ? 'me' : ''}>
                  <td className="rank">{r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : `#${r.rank}`}</td>
                  <td>{r.displayName}{r.isMe && <span className="pill gold" style={{ marginLeft: 8 }}>you</span>}</td>
                  <td className="mono gold" style={{ color: 'var(--gold)' }}>{fmt(Math.round(r.totalLbs))} lbs</td>
                  <td className="mono muted">{r.totalWorkouts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  )
}
