import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useForm } from 'react-hook-form'
import { useAuth } from '../context/AuthContext'

export function LoginPage() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const { register, handleSubmit, formState: { errors } } = useForm<{email:string;password:string}>()

  const onSubmit = async (d: {email:string;password:string}) => {
    setLoading(true); setErr('')
    try { await login(d.email, d.password); navigate('/') }
    catch (e: any) { setErr(e.response?.data?.error || 'Login failed') }
    finally { setLoading(false) }
  }

  return (
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'var(--bg-0)',padding:20}}>
      <div style={{width:'100%',maxWidth:420}}>
        <div style={{textAlign:'center',marginBottom:40}}>
          <div style={{fontFamily:'var(--font-display)',fontSize:'2rem',fontWeight:800,color:'var(--gold)',marginBottom:8}}>⚡ GAM</div>
          <div style={{color:'var(--text-2)',fontSize:'.875rem'}}>Landlord Portal — Gold Asset Management</div>
        </div>
        <div className="card" style={{padding:28}}>
          <h2 style={{marginBottom:24,fontSize:'1.2rem'}}>Sign in</h2>
          {err && <div className="alert alert-danger" style={{marginBottom:16}}>{err}</div>}
          <form onSubmit={handleSubmit(onSubmit)}>
            <div className="form-group">
              <label className="form-label">Email</label>
              <input className="form-input" type="email" {...register('email',{required:true})} placeholder="you@example.com" autoFocus />
            </div>
            <div className="form-group">
              <label className="form-label">Password</label>
              <input className="form-input" type="password" {...register('password',{required:true})} placeholder="••••••••" />
            </div>
            <button className="btn btn-primary w-full" type="submit" disabled={loading} style={{justifyContent:'center',marginTop:8}}>
              {loading ? <span className="spinner" /> : 'Sign in'}
            </button>
          </form>
          <p style={{textAlign:'center',marginTop:20,fontSize:'.82rem',color:'var(--text-3)'}}>
            No account? <Link to="/register">Register as landlord</Link>
          </p>
        </div>
      </div>
    </div>
  )
}
