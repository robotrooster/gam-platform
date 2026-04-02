import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'

export function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async () => {
    setError('')
    setLoading(true)
    try {
      await login(email, password)
      navigate('/pos')
    } catch {
      setError('Invalid email or password')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{minHeight:'100vh',background:'var(--bg-1)',display:'flex',alignItems:'center',justifyContent:'center'}}>
      <div style={{width:'100%',maxWidth:380,padding:24}}>
        {/* Header */}
        <div style={{textAlign:'center',marginBottom:40}}>
          <div style={{fontSize:'2.5rem',marginBottom:8}}>⚡</div>
          <div style={{fontSize:'1.6rem',fontWeight:700,color:'var(--gold)',letterSpacing:'-0.5px'}}>GAM POS</div>
          <div style={{fontSize:'.82rem',color:'var(--text-3)',marginTop:4}}>Point of Sale Terminal</div>
        </div>

        {/* Form */}
        <div className="card" style={{padding:28}}>
          {error && <div style={{background:'rgba(220,53,69,.08)',border:'1px solid rgba(220,53,69,.2)',borderRadius:8,padding:'10px 14px',fontSize:'.82rem',color:'var(--red)',marginBottom:16}}>{error}</div>}
          <div style={{marginBottom:14}}>
            <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:5}}>Email</div>
            <input className="form-input" type="email" placeholder="staff@example.com" value={email}
              onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==='Enter'&&submit()} style={{width:'100%'}} />
          </div>
          <div style={{marginBottom:20}}>
            <div style={{fontSize:'.75rem',color:'var(--text-3)',marginBottom:5}}>Password</div>
            <input className="form-input" type="password" placeholder="••••••••" value={password}
              onChange={e=>setPassword(e.target.value)} onKeyDown={e=>e.key==='Enter'&&submit()} style={{width:'100%'}} />
          </div>
          <button className="btn btn-primary" style={{width:'100%',padding:'12px 0',fontSize:'1rem'}}
            onClick={submit} disabled={loading||!email||!password}>
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </div>

        <div style={{textAlign:'center',marginTop:20,fontSize:'.75rem',color:'var(--text-3)'}}>
          Gold Asset Management · POS Terminal v1.0
        </div>
      </div>
    </div>
  )
}
