import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from 'react-query'
import { AuthProvider, useAuth } from './context/AuthContext'
import { LoginPage } from './pages/LoginPage'
import { POSPage } from './pages/POSPage'
import { InventoryPage } from './pages/InventoryPage'
import { ShelfLabelPage } from './pages/ShelfLabelPage'
import './styles/globals.css'

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 300000, refetchOnWindowFocus: false, refetchOnMount: false } } })

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { token, loading } = useAuth()
  if (loading) return <div className="loading-screen">Loading…</div>
  return token ? <>{children}</> : <Navigate to="/login" replace />
}

function POSLayout() {
  const { user, logout } = useAuth()
  return (
    <div style={{minHeight:'100vh',background:'var(--bg-1)'}}>
      <header style={{background:'var(--bg-2)',borderBottom:'1px solid var(--border-1)',padding:'0 20px',height:56,display:'flex',alignItems:'center',justifyContent:'space-between',position:'sticky',top:0,zIndex:100}}>
        <div style={{fontWeight:700,fontSize:'1.1rem',color:'var(--gold)'}}>⚡ GAM POS</div>
        <div style={{display:'flex',gap:16,alignItems:'center'}}>
          <a href="/pos" style={{fontSize:'.88rem',fontWeight:500}}>Register</a>
          <a href="/inventory" style={{fontSize:'.88rem',fontWeight:500}}>Inventory</a>
          <div style={{fontSize:'.82rem',color:'var(--text-3)'}}>{user?.firstName} {user?.lastName}</div>
          <button onClick={logout} style={{background:'none',border:'none',color:'var(--text-3)',cursor:'pointer',fontSize:'.82rem'}}>Sign out</button>
        </div>
      </header>
      <div style={{padding:20}}>
        <Routes>
          <Route path="/pos" element={<POSPage />} />
          <Route path="/inventory" element={<InventoryPage />} />
          <Route path="*" element={<Navigate to="/pos" replace />} />
        </Routes>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/shelf/:id" element={<ShelfLabelPage />} />
            <Route path="*" element={<PrivateRoute><POSLayout /></PrivateRoute>} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
)
