/**
 * 10/12 (Nic): the company's W-2 employees.
 *
 * GAM Books' own page, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts). How it reaches the API, shows a toast and
 * links to another Books page is the app's own (./adapter).
 */
import React, { useState } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import {
  formatCurrency, humanize, BOOKS_PAY_TYPES, BOOKS_PAY_TYPE_LABEL, BOOKS_PAY_FREQUENCIES, BOOKS_PAY_FREQUENCY_LABEL,
  BOOKS_PAY_PERIODS_PER_YEAR, BOOKS_EMPLOYEE_FILING_STATUSES, BOOKS_EMPLOYEE_FILING_STATUS_LABEL, booksDefaultHours,
  type BooksPayFrequency,
} from '@gam/shared'
import { booksGet as get, booksPost as post, booksPatch as patch } from './adapter'
import { Modal } from './common'

// ── EMPLOYEES ─────────────────────────────────────────────────────────
// 10/11: Add Employee could not save — it had no address box (the API
// requires one) and offered a 'married_higher' filing status the API refuses.
// Pay types, frequencies and filing statuses are now the API's own lists
// (packages/shared booksLedger), and every box the API requires is required here.

export function EmployeesPage(){
  const qc=useQueryClient()
  const{data:employees=[],isLoading}=useQuery('emp',()=>get<any[]>('/books/employees'))
  const[showAdd,setShowAdd]=useState(false)
  const[err,setErr]=useState('')
  const[saving,setSaving]=useState(false)
  const initForm={firstName:'',lastName:'',email:'',phone:'',address:'',title:'',department:'',payType:'salary',payRate:'',payFrequency:'biweekly',filingStatus:'single',federalAllowances:'0',stateWithholdingPct:'0',startDate:'',ssnLast4:''}
  const[form,setForm]=useState(initForm)
  const f=(k:string)=>(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement>)=>setForm(p=>({...p,[k]:e.target.value}))

  const activeEmp=(employees as any[]).filter((e:any)=>e.status==='active')
  const ytdGross=(employees as any[]).reduce((s:number,e:any)=>s+(+e.ytdGross||0),0)

  // A paycheck: salary over the year's pay periods; hourly at a full-time
  // period's hours (booksDefaultHours — what a run pays when no hours are entered).
  const calcPaycheck=(rate:number,freq:string,type:string)=>{
    const f=(BOOKS_PAY_FREQUENCIES as readonly string[]).includes(freq)?freq as BooksPayFrequency:'biweekly'
    return type==='salary'?rate/BOOKS_PAY_PERIODS_PER_YEAR[f]:rate*booksDefaultHours(f)
  }
  const ytdYear=(employees as any[])[0]?.ytdYear

  const addEmp=async(e:React.FormEvent)=>{
    e.preventDefault();setSaving(true);setErr('')
    try{
      await post('/books/employees',{...form,payRate:+form.payRate,federalAllowances:+form.federalAllowances,stateWithholdingPct:+form.stateWithholdingPct})
      qc.invalidateQueries('emp')
      setShowAdd(false);setForm(initForm)
    }catch(ex:any){setErr(ex.response?.data?.error||'Failed to save')}
    finally{setSaving(false)}
  }

  const toggleStatus=async(id:string,current:string)=>{
    await patch(`/books/employees/${id}`,{status:current==='active'?'inactive':'active'})
    qc.invalidateQueries('emp')
  }

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">👥 Employees (W-2)</h1><p className="ps">{activeEmp.length} active · {(employees as any[]).length} total</p></div>
        <button className="btn bp" onClick={()=>setShowAdd(true)}>+ Add Employee</button>
      </div>

      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">Active W-2</div><div className="kv b">{activeEmp.length}</div><div className="ks">Receiving payroll</div></div>
        <div className="kpi"><div className="kl">YTD Gross Pay</div><div className="kv gold">{formatCurrency(ytdGross)}</div><div className="ks">All employees{ytdYear?` · ${ytdYear}`:''}</div></div>
        <div className="kpi"><div className="kl">YTD Federal W/H</div><div className="kv a">{formatCurrency((employees as any[]).reduce((s:number,e:any)=>s+(+e.ytdFederalTax||0),0))}</div><div className="ks">Withheld YTD</div></div>
        <div className="kpi"><div className="kl">YTD State W/H</div><div className="kv t">{formatCurrency((employees as any[]).reduce((s:number,e:any)=>s+(+e.ytdStateTax||0),0))}</div><div className="ks">Per-employee flat %</div></div>
      </div>

      <div className="card" style={{padding:0}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
          <table className="tbl">
            <thead><tr><th>Employee</th><th>Title</th><th>Pay Type</th><th>Rate</th><th>Frequency</th><th>Per Check</th><th>YTD Gross{ytdYear?` (${ytdYear})`:''}</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {(employees as any[]).length?(employees as any[]).map((emp:any)=>(
                <tr key={emp.id}>
                  <td><div style={{fontWeight:600,color:'var(--t0)'}}>{emp.firstName} {emp.lastName}</div><div style={{fontSize:'.68rem',color:'var(--t3)'}}>{emp.email||'—'}</div></td>
                  <td style={{fontSize:'.75rem'}}>{emp.title||'—'}{emp.department&&<div style={{fontSize:'.68rem',color:'var(--t3)'}}>{emp.department}</div>}</td>
                  <td><span className={`badge ${emp.payType==='salary'?'bb':'ba'}`}>{(BOOKS_PAY_TYPE_LABEL as Record<string,string>)[emp.payType]??humanize(emp.payType)}</span></td>
                  <td className="mono">{emp.payType==='salary'?formatCurrency(emp.payRate)+'/yr':formatCurrency(emp.payRate)+'/hr'}</td>
                  <td style={{fontSize:'.75rem',color:'var(--t2)'}}>{(BOOKS_PAY_FREQUENCY_LABEL as Record<string,string>)[emp.payFrequency]??humanize(emp.payFrequency)}</td>
                  <td className="mono" style={{color:'var(--green)'}}>{formatCurrency(calcPaycheck(+emp.payRate,emp.payFrequency,emp.payType))}</td>
                  <td className="mono">{formatCurrency(emp.ytdGross)}</td>
                  <td><span className={`badge ${emp.status==='active'?'bg2':'bmu'}`}>{humanize(emp.status)}</span></td>
                  <td><button className={emp.status==='active'?'btn bd bsm':'btn bp bsm'} onClick={()=>toggleStatus(emp.id,emp.status)}>{emp.status==='active'?'Deactivate':'Activate'}</button></td>
                </tr>
              )):<tr><td colSpan={9}><div className="empty">No employees yet. Add your first W-2 employee.</div></td></tr>}
            </tbody>
          </table>
        )}
      </div>

      {showAdd&&(
        <Modal title="Add Employee (W-2)" onClose={()=>setShowAdd(false)}>
          {err&&<div className="alert ae">{err}</div>}
          <form onSubmit={addEmp}>
            <div className="frow2">
              <div><label>First Name</label><input type="text" value={form.firstName} onChange={f('firstName')} maxLength={100} required/></div>
              <div><label>Last Name</label><input type="text" value={form.lastName} onChange={f('lastName')} maxLength={100} required/></div>
            </div>
            <div className="frow2">
              <div><label>Email</label><input type="email" value={form.email} onChange={f('email')} maxLength={200} required/></div>
              <div><label>Phone</label><input type="tel" value={form.phone} onChange={f('phone')} minLength={7} maxLength={20} required/></div>
            </div>
            <div className="frow"><label>Home Address</label><input type="text" value={form.address} onChange={f('address')} placeholder="Street, city, state, ZIP" required/></div>
            <div className="frow2">
              <div><label>Title</label><input type="text" value={form.title} onChange={f('title')} placeholder="Property Manager" maxLength={100} required/></div>
              <div><label>Department</label><input type="text" value={form.department} onChange={f('department')} maxLength={100} required/></div>
            </div>
            <div className="frow2">
              <div><label>Pay Type</label>
                <select value={form.payType} onChange={f('payType')}>
                  {BOOKS_PAY_TYPES.map(t=><option key={t} value={t}>{t==='salary'?'Salary (annual)':BOOKS_PAY_TYPE_LABEL[t]}</option>)}
                </select>
              </div>
              <div><label>{form.payType==='salary'?'Annual Salary':'Hourly Rate'}</label>
                <input type="number" min="0" step="0.01" value={form.payRate} onChange={f('payRate')} required placeholder={form.payType==='salary'?'50000':'18.00'}/>
              </div>
            </div>
            <div className="frow2">
              <div><label>Pay Frequency</label>
                <select value={form.payFrequency} onChange={f('payFrequency')}>
                  {BOOKS_PAY_FREQUENCIES.map(p=><option key={p} value={p}>{BOOKS_PAY_FREQUENCY_LABEL[p]}</option>)}
                </select>
              </div>
              <div><label>Filing Status</label>
                <select value={form.filingStatus} onChange={f('filingStatus')}>
                  {BOOKS_EMPLOYEE_FILING_STATUSES.map(s=><option key={s} value={s}>{BOOKS_EMPLOYEE_FILING_STATUS_LABEL[s]}</option>)}
                </select>
              </div>
            </div>
            <div className="frow2">
              <div><label>State Withholding %</label><input type="number" min="0" max="10" step="0.1" value={form.stateWithholdingPct} onChange={f('stateWithholdingPct')}/></div>
              <div><label>Start Date</label><input type="date" value={form.startDate} onChange={f('startDate')} required/></div>
            </div>
            <div className="frow"><label>SSN Last 4</label><input type="text" inputMode="numeric" pattern="\d{4}" maxLength={4} value={form.ssnLast4} onChange={f('ssnLast4')} placeholder="For the W-2" required/></div>
            <div className="factions">
              <button type="button" className="btn bg-btn" onClick={()=>setShowAdd(false)}>Cancel</button>
              <button type="submit" className="btn bp" disabled={saving}>{saving?<><span className="spinner"/>Saving…</>:'Add Employee'}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
