/**
 * 10/12 (Nic): the Books dashboard: payroll head counts, the chart of accounts and the year's payroll so far.
 *
 * GAM Books' own page, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts). How it reaches the API, shows a toast and
 * links to another Books page is the app's own (./adapter).
 */
import { Link } from 'react-router-dom'
import { useQuery } from 'react-query'
import { formatCurrency } from '@gam/shared'
import { booksGet as get, booksPath } from './adapter'

// ── DASHBOARD ──────────────────────────────────────────────────────────
export function BooksDashboardPage(){
  const{data:employees=[]}=useQuery('emp',()=>get<any[]>('/books/employees'))
  // 10/12 (Nic): one list of everyone the company pays — contractors are vendors
  // of type contractor; what each was paid this year comes from its payments.
  const{data:vendors=[]}=useQuery(['ven',false],()=>get<any[]>('/books/vendors'))
  const contractors=(vendors as any[]).filter((v:any)=>v.vendorType==='contractor')
  const paidTo=(list:any[])=>list.reduce((s:number,v:any)=>s+(+v.paidThisYear||0),0)
  const{data:accounts=[]}=useQuery('acct',()=>get<any[]>('/books/accounts'))
  const now=new Date()
  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">Books Dashboard</h1><p className="ps">{now.toLocaleString('default',{month:'long',year:'numeric'})}</p></div>
        <span className="badge bgold">📒 GAM Books</span>
      </div>
      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">Employees (W-2)</div><div className="kv b">{(employees as any[]).filter((e:any)=>e.status==='active').length}</div><div className="ks">{(employees as any[]).length} total</div></div>
        <div className="kpi"><div className="kl">Contractors</div><div className="kv gold">{contractors.length}</div><div className="ks">{contractors.filter((c:any)=>c.is1099).length} with the 1099 box</div></div>
        <div className="kpi"><div className="kl">Vendors</div><div className="kv t">{(vendors as any[]).length}</div><div className="ks">Active vendors</div></div>
        <div className="kpi"><div className="kl">Chart of Accounts</div><div className="kv">{(accounts as any[]).length}</div><div className="ks">Active accounts</div></div>
      </div>
      <div className="grid2">
        <div className="card">
          <div className="ct">Quick Actions</div>
          <div style={{display:'flex',flexDirection:'column',gap:8}}>
            <Link to={booksPath('employees')}   className="btn bp">👥 Add Employee</Link>
            <Link to={booksPath('vendors')}     className="btn bp">🏪 Add a Vendor or Contractor</Link>
            <Link to={booksPath('loans')}       className="btn bp">🏦 Loans</Link>
            <Link to={booksPath('fixedAssets')} className="btn bp">🏗 Fixed Assets</Link>
            <Link to={booksPath('accounts')}    className="btn bp">📂 Manage Chart of Accounts</Link>
          </div>
        </div>
        <div className="card">
          <div className="ct">YTD Payroll Summary</div>
          <div className="dr"><span className="dk">Employee gross pay</span><span className="dv mono">{formatCurrency((employees as any[]).reduce((s:number,e:any)=>s+(+e.ytdGross||0),0))}</span></div>
          <div className="dr"><span className="dk">Contractor payments</span><span className="dv mono">{formatCurrency(paidTo(contractors))}</span></div>
          <div className="dr"><span className="dk">Other vendor payments</span><span className="dv mono">{formatCurrency(paidTo((vendors as any[]).filter((v:any)=>v.vendorType!=='contractor')))}</span></div>
          <div className="dr" style={{borderTop:'1px solid var(--b1)',paddingTop:8,marginTop:4}}><span className="dk" style={{fontWeight:700}}>Total YTD disbursed</span><span className="dv mono" style={{color:'var(--gold)',fontWeight:700}}>{formatCurrency((employees as any[]).reduce((s:number,e:any)=>s+(+e.ytdGross||0),0)+paidTo(vendors as any[]))}</span></div>
        </div>
      </div>
    </div>
  )
}
