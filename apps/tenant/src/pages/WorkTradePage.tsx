import { useState, useEffect } from 'react'
import { apiGet, apiPost } from '../lib/api'
import { Clock, Check, X, Plus, AlertCircle } from 'lucide-react'

const fmt = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export function WorkTradePage() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [showLog, setShowLog] = useState(false)
  const [form, setForm] = useState({ workDate: new Date().toISOString().split('T')[0], hours: '', description: '' })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  const load = async () => {
    try {
      // Get tenant's unit, then agreement
      const me = await apiGet('/tenants/me')
      if (!(me as any).unit_id) { setLoading(false); return }
      const agreement = await apiGet(`/work-trade/unit/${(me as any).unit_id}`)
      if (!agreement) { setLoading(false); return }
      const detail = await apiGet(`/work-trade/${(agreement as any).id}`)
      setData(detail)
    } catch (e) {}
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const submitHours = async () => {
    if (!form.hours || !form.description) { setError('All fields required'); return }
    setSubmitting(true)
    setError('')
    try {
      await apiPost(`/work-trade/${data.agreement.id}/logs`, {
        workDate: form.workDate,
        hours: parseFloat(form.hours),
        description: form.description,
      })
      setSuccess(true)
      setShowLog(false)
      setForm({ workDate: new Date().toISOString().split('T')[0], hours: '', description: '' })
      load()
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Failed to submit. Try again.')
    }
    setSubmitting(false)
  }

  const style = {
    page: { padding: 20, fontFamily: 'system-ui', background: '#060809', minHeight: '100vh', color: '#b8c4d8' } as React.CSSProperties,
    card: { background: '#0a0d10', border: '1px solid #1e2530', borderRadius: 12, padding: 16, marginBottom: 16 } as React.CSSProperties,
    label: { fontSize: '.65rem', fontWeight: 700, color: '#7a8aaa', textTransform: 'uppercase' as const, letterSpacing: '.08em', marginBottom: 4, display: 'block' },
    val:  { fontFamily: 'monospace', fontSize: '.9rem', fontWeight: 700, color: '#eef1f8' },
    input: { width: '100%', padding: '9px 11px', background: '#141920', border: '1px solid #252e3d', borderRadius: 8, color: '#eef1f8', fontSize: '.85rem', outline: 'none', fontFamily: 'system-ui', boxSizing: 'border-box' as const },
  }

  if (loading) return <div style={{ ...style.page, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><div style={{ width: 28, height: 28, border: '3px solid #1a2028', borderTopColor: '#c9a227', borderRadius: '50%', animation: 'spin 1s linear infinite' }} /></div>

  if (!data) return (
    <div style={style.page}>
      <div style={{ textAlign: 'center', paddingTop: 60, color: '#3d4d68' }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🔧</div>
        <div style={{ fontSize: '.9rem', fontWeight: 600, color: '#7a8aaa' }}>No work trade agreement</div>
        <div style={{ fontSize: '.78rem', marginTop: 6 }}>You don't have an active work trade arrangement.</div>
      </div>
    </div>
  )

  const agreement = data.agreement
  const logs = data.logs || []
  const stats = data.stats || {}
  const pending = logs.filter((l: any) => l.status === 'pending')
  const approved = logs.filter((l: any) => l.status === 'approved')
  const rejected = logs.filter((l: any) => l.status === 'rejected')
  const monthlyCommit = parseFloat(agreement.weekly_hours) * (52 / 12)
  const hoursLeft = Math.max(0, monthlyCommit - stats.hoursThisPeriod)
  const progress = Math.min(100, (stats.hoursThisPeriod / monthlyCommit) * 100)

  const typeColors: Record<string, string> = { full: '#1edb7a', partial: '#c9a227', credit: '#4a9eff' }
  const typeColor = typeColors[agreement.trade_type] || '#c9a227'

  return (
    <div style={style.page}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>

      {success && (
        <div style={{ background: 'rgba(30,219,122,.1)', border: '1px solid rgba(30,219,122,.3)', borderRadius: 10, padding: '10px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8, fontSize: '.82rem', color: '#1edb7a', fontWeight: 600 }}>
          <Check size={15} /> Hours submitted for approval!
        </div>
      )}

      {/* Agreement header */}
      <div style={style.card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: '1rem', fontWeight: 800, color: '#eef1f8' }}>Work Trade Agreement</div>
            <div style={{ fontSize: '.72rem', color: '#7a8aaa', marginTop: 2 }}>Unit {agreement.unit_number} · {agreement.property_name}</div>
          </div>
          <span style={{ fontSize: '.65rem', padding: '3px 10px', borderRadius: 10, background: `${typeColor}18`, border: `1px solid ${typeColor}40`, color: typeColor, fontWeight: 700, textTransform: 'uppercase' as const }}>
            {agreement.trade_type} trade
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 10, marginBottom: 14 }}>
          {[
            { label: 'Your Rate', val: `${fmt(agreement.hourly_rate)}/hr` },
            { label: 'Weekly Hours', val: `${agreement.weekly_hours} hrs` },
            { label: 'Cash Due', val: fmt(agreement.cash_rent) },
          ].map(s => (
            <div key={s.label} style={{ background: '#0f1318', border: '1px solid #1e2530', borderRadius: 8, padding: '10px 12px' }}>
              <div style={style.label}>{s.label}</div>
              <div style={style.val}>{s.val}</div>
            </div>
          ))}
        </div>

        {agreement.duties && (
          <div style={{ background: '#0f1318', border: '1px solid #1e2530', borderRadius: 8, padding: '10px 12px' }}>
            <div style={style.label}>Your Duties</div>
            <div style={{ fontSize: '.78rem', color: '#b8c4d8', lineHeight: 1.6 }}>{agreement.duties}</div>
          </div>
        )}
      </div>

      {/* This month progress */}
      <div style={style.card}>
        <div style={{ fontSize: '.8rem', fontWeight: 700, color: '#eef1f8', marginBottom: 12 }}>This Month's Progress</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.78rem', marginBottom: 6 }}>
          <span style={{ color: '#7a8aaa' }}>Hours worked</span>
          <span style={{ fontFamily: 'monospace', color: '#eef1f8', fontWeight: 600 }}>{stats.hoursThisPeriod?.toFixed(1) || '0.0'} / {monthlyCommit.toFixed(1)} hrs</span>
        </div>
        <div style={{ height: 8, background: '#141920', borderRadius: 4, overflow: 'hidden', marginBottom: 8 }}>
          <div style={{ height: '100%', width: `${progress}%`, background: progress >= 100 ? '#1edb7a' : '#c9a227', borderRadius: 4, transition: 'width .3s' }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '.72rem', color: '#7a8aaa' }}>
          <span>{hoursLeft > 0 ? `${hoursLeft.toFixed(1)} hrs remaining` : '✓ Commitment met!'}</span>
          <span>{pending.length > 0 ? `${pending.length} pending approval` : ''}</span>
        </div>
      </div>

      {/* Log hours button */}
      <button onClick={() => setShowLog(true)} style={{ width: '100%', padding: 13, borderRadius: 10, border: 'none', background: 'linear-gradient(135deg, #8a6c10, #c9a227)', color: '#060809', fontWeight: 700, fontSize: '.9rem', cursor: 'pointer', marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
        <Clock size={16} /> Log Hours
      </button>

      {/* Log hours form */}
      {showLog && (
        <div style={style.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ fontSize: '.88rem', fontWeight: 700, color: '#eef1f8' }}>Log Hours</div>
            <button onClick={() => setShowLog(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#7a8aaa' }}><X size={16} /></button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
            <div>
              <label style={style.label}>Work Date</label>
              <input type="date" style={style.input} value={form.workDate} onChange={e => setForm(f => ({ ...f, workDate: e.target.value }))} />
            </div>
            <div>
              <label style={style.label}>Hours Worked</label>
              <input type="number" step="0.5" placeholder="2.5" style={style.input} value={form.hours} onChange={e => setForm(f => ({ ...f, hours: e.target.value }))} />
            </div>
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={style.label}>What did you do?</label>
            <textarea style={{ ...style.input, resize: 'vertical' as const }} rows={3} placeholder="Describe the work performed…" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
          </div>
          {error && <div style={{ color: '#ff4757', fontSize: '.75rem', marginBottom: 10 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setShowLog(false)} style={{ flex: 1, padding: 10, borderRadius: 8, border: '1px solid #252e3d', background: '#141920', color: '#7a8aaa', cursor: 'pointer', fontWeight: 600 }}>Cancel</button>
            <button onClick={submitHours} disabled={submitting} style={{ flex: 2, padding: 10, borderRadius: 8, border: 'none', background: '#c9a227', color: '#060809', fontWeight: 700, cursor: 'pointer' }}>
              {submitting ? '…' : 'Submit Hours'}
            </button>
          </div>
        </div>
      )}

      {/* Recent logs */}
      {logs.length > 0 && (
        <div style={style.card}>
          <div style={{ fontSize: '.8rem', fontWeight: 700, color: '#eef1f8', marginBottom: 12 }}>Your Hours Log</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {logs.slice(0, 15).map((log: any) => (
              <div key={log.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: '#0f1318', border: '1px solid #1e2530', borderRadius: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '.78rem', color: '#eef1f8', fontWeight: 500 }}>{log.description}</div>
                  <div style={{ fontSize: '.68rem', color: '#7a8aaa', marginTop: 2 }}>
                    {new Date(log.work_date).toLocaleDateString()} · {log.hours}h
                    {log.credit_value ? ` · ${fmt(log.credit_value)} credit` : ''}
                  </div>
                </div>
                <span style={{
                  fontSize: '.62rem', padding: '2px 8px', borderRadius: 10, fontWeight: 700,
                  background: log.status === 'approved' ? 'rgba(30,219,122,.1)' : log.status === 'rejected' ? 'rgba(255,71,87,.1)' : 'rgba(255,184,32,.1)',
                  border: `1px solid ${log.status === 'approved' ? 'rgba(30,219,122,.3)' : log.status === 'rejected' ? 'rgba(255,71,87,.3)' : 'rgba(255,184,32,.3)'}`,
                  color: log.status === 'approved' ? '#1edb7a' : log.status === 'rejected' ? '#ff4757' : '#ffb820',
                }}>
                  {log.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
