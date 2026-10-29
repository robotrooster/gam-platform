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
  BOOKS_EMPLOYEE_PAY_PLACES, BOOKS_EMPLOYEE_PAY_PLACE_LABEL,
  type BooksPayFrequency, type BooksEmployeePayPlace,
} from '@gam/shared'
import { booksGet as get, booksPost as post, booksPatch as patch, useBooksRole } from './adapter'
import { Modal } from './common'
import { useCostPlaces, type CostPlaceProperty } from './CostPlaceField'

// ── WHERE AN EMPLOYEE'S PAY GOES ──────────────────────────────────────
// 10/14 (Nic): "an employee at one property goes to that property ... once you
// set it it shouldnt change. if they work at multiple properties it would be
// at the company level." Asked on the employee: each paycheck follows it, and
// Run Payroll no longer asks. Nothing is chosen for the person. 10/14
// afternoon (Nic): "the owner can change it; only future paychecks follow" —
// the owner sees Change beside it (a mistake, or the person moved); anyone
// else sees it, not a button (the API refuses them too). A draft run's
// paychecks move with the change; approved runs stay as they posted. A
// business's books have no properties, so nothing is asked of a business.
type PayPlaceValue={payPlace:BooksEmployeePayPlace|'';payPropertyId:string}
const BLANK_PAY_PLACE:PayPlaceValue={payPlace:'',payPropertyId:''}
const payPlaceChosen=(v:PayPlaceValue)=>v.payPlace==='company'||(v.payPlace==='property'&&!!v.payPropertyId)
const PAY_PLACE_HELP:Record<BooksEmployeePayPlace,string>={
  property:'They work at one property: their pay goes to it.',
  company:'They work at several properties: their pay goes to the company.',
}
/** Where an employee's pay goes, in words, for the list. */
export function payPlaceText(emp:{payPlace?:string|null;payPropertyName?:string|null}):string{
  if(emp.payPlace==='company')return 'Company level'
  if(emp.payPlace==='property')return emp.payPropertyName||BOOKS_EMPLOYEE_PAY_PLACE_LABEL.property
  return ''
}
function PayPlaceField({value,onChange,properties,name='payPlace'}:{value:PayPlaceValue;onChange:(v:PayPlaceValue)=>void;properties:CostPlaceProperty[];name?:string}){
  return(
    <div className="frow">
      <label>Where their pay goes</label>
      {BOOKS_EMPLOYEE_PAY_PLACES.map(p=>(
        <label key={p} style={{display:'flex',gap:8,alignItems:'flex-start',textTransform:'none',letterSpacing:0,fontWeight:400,fontSize:'.8rem',color:'var(--t1)',marginBottom:6,cursor:'pointer'}}>
          <input type="radio" name={name} value={p} checked={value.payPlace===p} onChange={()=>onChange({payPlace:p,payPropertyId:p==='property'?value.payPropertyId:''})}
            style={{width:'auto',marginTop:3,accentColor:'var(--gold)'}}/>
          <span><span style={{fontWeight:600,color:'var(--t0)'}}>{BOOKS_EMPLOYEE_PAY_PLACE_LABEL[p]}</span>
            <span style={{display:'block',fontSize:'.72rem',color:'var(--t3)'}}>{PAY_PLACE_HELP[p]}</span></span>
        </label>
      ))}
      {value.payPlace==='property'&&(
        <select value={value.payPropertyId} required onChange={e=>onChange({...value,payPropertyId:e.target.value})}>
          <option value="">Choose the property</option>
          {properties.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      )}
    </div>
  )
}

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
  // 10/14 (Nic): where the new employee's pay goes — nothing chosen until the person chooses.
  const[place,setPlace]=useState<PayPlaceValue>(BLANK_PAY_PLACE)
  const{properties,asked}=useCostPlaces()
  // An employee with no place yet (added before 10/14) is set here; the
  // owner changes a set one here too (10/14 afternoon).
  const isOwner=useBooksRole()==='landlord'
  const[placing,setPlacing]=useState<any|null>(null)
  const[placingValue,setPlacingValue]=useState<PayPlaceValue>(BLANK_PAY_PLACE)
  const[placeErr,setPlaceErr]=useState('')
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
      await post('/books/employees',{...form,payRate:+form.payRate,federalAllowances:+form.federalAllowances,stateWithholdingPct:+form.stateWithholdingPct,
        ...(asked?{payPlace:place.payPlace||null,payPropertyId:place.payPlace==='property'?place.payPropertyId||null:null}:{})})
      qc.invalidateQueries('emp')
      setShowAdd(false);setForm(initForm);setPlace(BLANK_PAY_PLACE)
    }catch(ex:any){setErr(ex.response?.data?.error||'Failed to save')}
    finally{setSaving(false)}
  }

  const savePlace=async()=>{
    if(!placing)return
    setSaving(true);setPlaceErr('')
    try{
      await patch(`/books/employees/${placing.id}`,{payPlace:placingValue.payPlace||null,payPropertyId:placingValue.payPlace==='property'?placingValue.payPropertyId||null:null})
      qc.invalidateQueries('emp')
      setPlacing(null);setPlacingValue(BLANK_PAY_PLACE)
    }catch(ex:any){setPlaceErr(ex.response?.data?.error||'Failed to save')}
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
            <thead><tr><th>Employee</th><th>Title</th><th>Pay Type</th><th>Rate</th><th>Frequency</th><th>Per Check</th><th>YTD Gross{ytdYear?` (${ytdYear})`:''}</th>{asked&&<th>Pay Goes To</th>}<th>Status</th><th></th></tr></thead>
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
                  {asked&&<td style={{fontSize:'.75rem',color:'var(--t2)'}}>{emp.payPlace?(
                    <div style={{display:'flex',alignItems:'center',gap:8}}>
                      <span>{payPlaceText(emp)}</span>
                      {isOwner&&<button className="btn bp bsm" onClick={()=>{setPlacing(emp);setPlacingValue(BLANK_PAY_PLACE);setPlaceErr('')}}>Change</button>}
                    </div>
                  ):(
                    <button className="btn bp bsm" onClick={()=>{setPlacing(emp);setPlacingValue(BLANK_PAY_PLACE);setPlaceErr('')}}>Set where pay goes</button>
                  )}</td>}
                  <td><span className={`badge ${emp.status==='active'?'bg2':'bmu'}`}>{humanize(emp.status)}</span></td>
                  <td><button className={emp.status==='active'?'btn bd bsm':'btn bp bsm'} onClick={()=>toggleStatus(emp.id,emp.status)}>{emp.status==='active'?'Deactivate':'Activate'}</button></td>
                </tr>
              )):<tr><td colSpan={asked?10:9}><div className="empty">No employees yet. Add your first W-2 employee.</div></td></tr>}
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
            {asked&&<PayPlaceField value={place} onChange={setPlace} properties={properties}/>}
            <div className="factions">
              <button type="button" className="btn bg-btn" onClick={()=>setShowAdd(false)}>Cancel</button>
              <button type="submit" className="btn bp" disabled={saving||(asked&&!payPlaceChosen(place))}>{saving?<><span className="spinner"/>Saving…</>:'Add Employee'}</button>
            </div>
          </form>
        </Modal>
      )}

      {placing&&(
        <Modal title={`Where ${placing.firstName} ${placing.lastName}'s pay goes`} onClose={()=>setPlacing(null)}>
          {placeErr&&<div className="alert ae">{placeErr}</div>}
          <p style={{fontSize:'.78rem',color:'var(--t2)',marginBottom:10}}>{placing.payPlace
            ?`Their pay goes to ${payPlaceText(placing)} now. Their next paychecks go to the new place; paychecks already approved stay where they were booked.`
            :'Each paycheck goes here. Only the owner can change it later.'}</p>
          <PayPlaceField value={placingValue} onChange={setPlacingValue} properties={properties} name="payPlaceSet"/>
          <div className="factions">
            <button type="button" className="btn bg-btn" onClick={()=>setPlacing(null)}>Cancel</button>
            <button type="button" className="btn bp" disabled={saving||!payPlaceChosen(placingValue)} onClick={savePlace}>{saving?<><span className="spinner"/>Saving…</>:'Save'}</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
