/**
 * 10/12 (Nic): running payroll — calculate, review and approve a pay run.
 *
 * GAM Books' own page, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts). How it reaches the API, shows a toast and
 * links to another Books page is the app's own (./adapter).
 *
 * 10/12 (Nic, ledger P7): each paycheck records the employer's own taxes —
 * Social Security and Medicare worked out by GAM, federal and state
 * unemployment tax as entered (the rate depends on the employer's state and
 * record). Approving books the run on its pay date and leaves each paycheck's
 * take-home pay and each payroll tax as unpaid bills on Expenses. Work-trade
 * extra hours the landlord sent to GAM Books are paid here too: W-2 hours as
 * their own paycheck on this run, 1099 hours as an unpaid contractor bill.
 *
 * 10/13 (Nic): "each expense is chosen on the split or specific unit or
 * property at the time of logging. there should never be a default setting to
 * apply expenses" — payroll is logged by a person, so each run asks where its
 * wages and the employer's taxes go (split across the properties by units, one
 * property, or one unit) before it is calculated; nothing carries over from
 * one run to the next.
 */
import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from 'react-query'
import {
  formatCurrency, humanize, BOOKS_PAY_TYPE_LABEL, BOOKS_PAY_FREQUENCIES, BOOKS_PAY_FREQUENCY_LABEL,
  BOOKS_PAY_PERIODS_PER_YEAR, booksDefaultHours, socialSecurityWageBase, WORK_TRADE_EXTRA_PAY_METHOD_LABEL,
  BOOKS_COST_PLACE_LABEL, type BooksPayFrequency,
} from '@gam/shared'
import { booksGet as get, booksPost as post, toast, appConfirm, booksPath } from './adapter'
import { payFreqLabel } from './common'
import { localToday } from './booksMoney'
import { CostPlaceField, useCostPlaces, costPlaceChosen, costPlaceBody, BLANK_COST_PLACE, type CostPlaceValue } from './CostPlaceField'

// ── RUN PAYROLL ───────────────────────────────────────────────────────
// 10/11: frequencies, their labels and the hourly default hours are the API's
// own (packages/shared booksLedger), so this preview shows what the run pays.

type Taxes={federal:string;state:string;futa:string;suta:string}
const NO_TAXES:Taxes={federal:'',state:'',futa:'',suta:''}
const taxBody=(t:Taxes|undefined)=>({federal:+(t?.federal||0),state:+(t?.state||0),futa:+(t?.futa||0),suta:+(t?.suta||0)})
const traderName=(x:any)=>`${x.tenantFirst??''} ${x.tenantLast??''}`.trim()||'Work trader'
const monthOf=(d:string)=>new Date(String(d).slice(0,10)+'T12:00:00').toLocaleDateString('en-US',{month:'long',year:'numeric'})
const payMethodLabel=(m:string)=>(WORK_TRADE_EXTRA_PAY_METHOD_LABEL as Record<string,string>)[m]??humanize(m)

export function RunPayrollPage(){
  const qc=useQueryClient()
  const{data:employees=[]}=useQuery('emp',()=>get<any[]>('/books/employees'))
  // Work-trade extra hours the landlord sent to GAM Books, waiting to be paid here.
  const{data:sent=[]}=useQuery('work-trade-pay',()=>get<any[]>('/books/work-trade-pay'),{retry:false})
  const{data:vendors=[]}=useQuery('vend',()=>get<any[]>('/books/vendors'),{retry:false})
  const active=(employees as any[]).filter((e:any)=>e.status==='active')
  const w2=(sent as any[]).filter((x:any)=>x.payMethod==='payroll_w2')
  const contractor=(sent as any[]).filter((x:any)=>x.payMethod==='contractor_1099')
  const[step,setStep]=useState<'setup'|'review'|'done'>('setup')
  const[selectedIds,setSelectedIds]=useState<string[]>([])
  const[hoursMap,setHoursMap]=useState<Record<string,string>>({})
  // The person running payroll enters income-tax withholding and the
  // unemployment taxes per paycheck (GAM works out only Social Security and
  // Medicare, the same fixed rates for everyone). Keyed by employee id.
  const[taxMap,setTaxMap]=useState<Record<string,Taxes>>({})
  const setTax=(id:string,k:keyof Taxes,v:string)=>setTaxMap(m=>({...m,[id]:{...NO_TAXES,...m[id],[k]:v}}))
  // W-2 extra hours put on this run: which employee each work trader is, and their taxes.
  const[extraOn,setExtraOn]=useState<Record<string,boolean>>({})
  const[extraEmp,setExtraEmp]=useState<Record<string,string>>({})
  const[extraTax,setExtraTax]=useState<Record<string,Taxes>>({})
  const setExtraTaxField=(id:string,k:keyof Taxes,v:string)=>setExtraTax(m=>({...m,[id]:{...NO_TAXES,...m[id],[k]:v}}))
  // 1099 extra hours: the vendor each is paid as ('' = the vendor list's own record of that person).
  const[contractorVendor,setContractorVendor]=useState<Record<string,string>>({})
  // 10/13 (Nic): "except gams charge all those costs get logged by a person" —
  // where each contractor bill's cost goes, asked on each one, never remembered.
  const[contractorPlace,setContractorPlace]=useState<Record<string,CostPlaceValue>>({})
  const[recording,setRecording]=useState<string|null>(null)
  // 10/13 (Nic): where this run's wages go — asked on every run, never remembered.
  const{properties,asked}=useCostPlaces()
  const[place,setPlace]=useState<CostPlaceValue>(BLANK_COST_PLACE)
  const[freq,setFreq]=useState<BooksPayFrequency>('biweekly')
  const defaultHours=booksDefaultHours(freq)
  const[periodStart,setPeriodStart]=useState('')
  const[periodEnd,setPeriodEnd]=useState('')
  const[payDate,setPayDate]=useState('')
  const[draftRun,setDraftRun]=useState<any>(null)
  const[calculating,setCalculating]=useState(false)
  const[approving,setApproving]=useState(false)
  const[err,setErr]=useState('')

  const toggleEmp=(id:string)=>setSelectedIds(s=>s.includes(id)?s.filter(x=>x!==id):[...s,id])
  const toggleAll=()=>setSelectedIds(s=>s.length===active.length?[]:active.map((e:any)=>e.id))
  const extraChosen=w2.filter((x:any)=>extraOn[x.id])
  const empFor=(x:any)=>extraEmp[x.id]??x.employeeId??''

  const calcRun=async(e:React.FormEvent)=>{
    e.preventDefault();setCalculating(true);setErr('')
    try{
      const missing=extraChosen.find((x:any)=>!empFor(x))
      if(missing)throw new Error(`Choose which employee ${traderName(missing)} is.`)
      const r=await post<any>('/books/payroll/runs',{
        periodStart,periodEnd,payDate,payFrequency:freq,
        employeeIds:selectedIds,
        // 10/11: only boxes with something typed. A blank box means "a full
        // period" (the server's default); a typed 0 means no hours, and pays $0.
        hoursMap:Object.fromEntries(Object.entries(hoursMap).filter(([,v])=>v!=='').map(([k,v])=>[k,+v])),
        taxMap:Object.fromEntries(selectedIds.map(id=>[id,taxBody(taxMap[id])])),
        extraHours:extraChosen.map((x:any)=>({id:x.id,employeeId:empFor(x),...taxBody(extraTax[x.id])})),
        ...(asked?costPlaceBody(place):{}),
      })
      setDraftRun(r.data)
      setStep('review')
    }catch(ex:any){setErr(ex.response?.data?.error||ex.message||'Calculation failed')}
    finally{setCalculating(false)}
  }

  const approve=async()=>{
    if(!(await appConfirm('Approve this payroll run? It is booked on the pay date, year-to-date figures are updated, and each paycheck\'s take-home pay and the payroll taxes go on Expenses as unpaid bills. GAM does not send the pay itself.', { confirmLabel: 'Approve' })))return
    setApproving(true);setErr('')
    try{
      await post(`/books/payroll/runs/${draftRun.id}/approve`)
      qc.invalidateQueries('emp')
      qc.invalidateQueries('payroll-runs')
      qc.invalidateQueries('work-trade-pay')
      setStep('done')
    }catch(ex:any){setErr(ex.response?.data?.error||'Approval failed')}
    finally{setApproving(false)}
  }

  // A draft holds the work-trade hours on it, so leaving it voids it.
  const discardDraft=async(ask:boolean)=>{
    if(!draftRun)return true
    if(ask&&!(await appConfirm('Void this draft run?', { danger: true, confirmLabel: 'Void' })))return false
    try{
      await post(`/books/payroll/runs/${draftRun.id}/void`)
      setDraftRun(null);setStep('setup')
      qc.invalidateQueries('payroll-runs')
      qc.invalidateQueries('work-trade-pay')
      return true
    }catch(ex:any){toast.error(ex.response?.data?.error||'Could not void this run.');return false}
  }
  const startOver=async()=>{
    if(step==='review'&&!(await discardDraft(false)))return
    setStep('setup');setDraftRun(null)
  }

  const recordContractor=async(x:any)=>{
    const vendorId=contractorVendor[x.id]||''
    const where=contractorPlace[x.id]??BLANK_COST_PLACE
    const to=vendorId?((vendors as any[]).find((v:any)=>v.id===vendorId)?.name??'the vendor'):traderName(x)
    if(!(await appConfirm(`Record ${formatCurrency(x.amount)} for ${traderName(x)}'s extra hours (${monthOf(x.periodMonth)}) as an unpaid contractor bill to ${to}? It counts toward their 1099, and paying the bill pays the hours.`, { confirmLabel: 'Record bill' })))return
    setRecording(x.id)
    try{
      await post(`/books/work-trade-pay/${x.id}/contractor-payment`,{...(vendorId?{vendorId}:{}),...(asked?costPlaceBody(where):{})})
      setContractorPlace(m=>{const n={...m};delete n[x.id];return n})
      qc.invalidateQueries('work-trade-pay')
      toast(`${traderName(x)}'s extra hours are on Expenses as an unpaid contractor bill.`)
    }catch(ex:any){toast.error(ex.response?.data?.error||'Could not record this bill.')}
    finally{setRecording(null)}
  }

  const fmtFreq=payFreqLabel
  // The Social Security wage base of the pay date's year (the year the run's
  // wages count toward), else this year's.
  const ssBaseYear=Number((payDate||localToday()).slice(0,4))
  const employerTaxes=draftRun?(+draftRun.totalEmployerSs)+(+draftRun.totalEmployerMedicare)+(+draftRun.totalFuta)+(+draftRun.totalSuta):0
  const taxInput=(value:string,onChange:(v:string)=>void,disabled:boolean)=>(
    <input type="number" min="0" step="0.01" style={{width:84}} placeholder="0.00" value={value} onChange={e=>onChange(e.target.value)} disabled={disabled}/>
  )
  const canCalc=(selectedIds.length>0||extraChosen.length>0)&&(!asked||costPlaceChosen(place))
  // 10/13 (Nic): the run's place, in words, for the review.
  const runPlaceWords=(r:any)=>r?.costPlace==='split_by_units'?BOOKS_COST_PLACE_LABEL.split_by_units
    :r?.unitNumber?`${r.propertyName??''} · Unit ${r.unitNumber}`:r?.propertyName??'—'

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">▶ Run Payroll</h1><p className="ps">Calculate, review, and approve payroll for your employees</p></div>
        {step!=='setup'&&<button className="btn bg-btn" onClick={startOver}>← Start Over</button>}
      </div>

      {err&&<div className="alert ae">{err}</div>}

      {/* STEP 1 — SETUP */}
      {step==='setup'&&(
        <form onSubmit={calcRun}>
          <div className="grid2" style={{marginBottom:16}}>
            <div className="card">
              <div className="ct">Pay Period</div>
              <div className="frow"><label>Pay Frequency</label>
                <select value={freq} onChange={e=>setFreq(e.target.value as BooksPayFrequency)}>
                  {BOOKS_PAY_FREQUENCIES.map(o=><option key={o} value={o}>{BOOKS_PAY_FREQUENCY_LABEL[o]}</option>)}
                </select>
              </div>
              <div className="frow2">
                <div><label>Period Start</label><input type="date" value={periodStart} onChange={e=>setPeriodStart(e.target.value)} required/></div>
                <div><label>Period End</label><input type="date" value={periodEnd} onChange={e=>setPeriodEnd(e.target.value)} required/></div>
              </div>
              <div className="frow"><label>Pay Date</label><input type="date" value={payDate} onChange={e=>setPayDate(e.target.value)} required/></div>
            </div>

            <div className="card">
              <div className="ct">Taxes on each paycheck</div>
              <div className="dr"><span className="dk">Social Security</span><span className="dv mono">6.2% each side (up to {formatCurrency(socialSecurityWageBase(ssBaseYear))} in {ssBaseYear}) — auto</span></div>
              <div className="dr"><span className="dk">Medicare</span><span className="dv mono">1.45% each side (+0.9% employee over $200k) — auto</span></div>
              <div className="dr"><span className="dk">Federal and state withholding</span><span className="dv mono">You enter</span></div>
              <div className="dr"><span className="dk">Federal and state unemployment</span><span className="dv mono">You enter (employer's)</span></div>
              <div style={{marginTop:10,fontSize:'.72rem',color:'var(--t3)'}}>GAM works out Social Security and Medicare (fixed rates for everyone). Enter income-tax withholding and the unemployment taxes for each paycheck below — leave a box blank for $0.</div>
            </div>
          </div>

          <div className="card" style={{marginBottom:16}}>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,marginBottom:14,flexWrap:'wrap'}}>
              <div className="ct" style={{marginBottom:0}}>Select Employees ({selectedIds.length}/{active.length})</div>
              <button type="button" className="btn bp bsm" onClick={toggleAll}>{selectedIds.length===active.length?'Deselect All':'Select All'}</button>
            </div>
            {active.length===0?<div className="empty">No active employees. Add employees first.</div>:(
              <div style={{overflowX:'auto'}}>
                <table className="tbl" style={{minWidth:960}}>
                  <thead><tr><th style={{width:40}}></th><th>Employee</th><th>Type</th><th>Rate</th><th>Hours (if hourly)</th><th>Est. Gross</th><th>Federal W/H</th><th>State W/H</th><th>Federal unemp.</th><th>State unemp.</th></tr></thead>
                  <tbody>
                    {active.map((emp:any)=>{
                      const ppy=BOOKS_PAY_PERIODS_PER_YEAR[freq]
                      const h=(hoursMap[emp.id]===''||hoursMap[emp.id]===undefined)?defaultHours:+hoursMap[emp.id]
                      const gross=emp.payType==='salary'?(+emp.payRate/ppy):(+emp.payRate*h)
                      const off=!selectedIds.includes(emp.id)
                      const t=taxMap[emp.id]??NO_TAXES
                      return(
                        <tr key={emp.id} style={{background:off?'':'rgba(201,162,39,.04)'}}>
                          <td><input type="checkbox" aria-label={`Pay ${emp.firstName} ${emp.lastName}`} checked={!off} onChange={()=>toggleEmp(emp.id)} style={{width:'auto',cursor:'pointer'}}/></td>
                          <td><div style={{fontWeight:600,color:'var(--t0)'}}>{emp.firstName} {emp.lastName}</div><div style={{fontSize:'.68rem',color:'var(--t3)'}}>{emp.title||''}</div></td>
                          <td><span className={`badge ${emp.payType==='salary'?'bb':'ba'}`}>{(BOOKS_PAY_TYPE_LABEL as Record<string,string>)[emp.payType]??humanize(emp.payType)}</span></td>
                          <td className="mono">{emp.payType==='salary'?formatCurrency(emp.payRate)+'/yr':formatCurrency(emp.payRate)+'/hr'}</td>
                          <td>{emp.payType==='hourly'?(
                            <input type="number" min="0" step="0.01" style={{width:80}} value={hoursMap[emp.id]??String(defaultHours)} onChange={e=>setHoursMap(m=>({...m,[emp.id]:e.target.value}))} disabled={off}/>
                          ):<span style={{color:'var(--t3)'}}>—</span>}</td>
                          <td className="mono" style={{color:'var(--green)'}}>{formatCurrency(gross)}</td>
                          <td>{taxInput(t.federal,v=>setTax(emp.id,'federal',v),off)}</td>
                          <td>{taxInput(t.state,v=>setTax(emp.id,'state',v),off)}</td>
                          <td>{taxInput(t.futa,v=>setTax(emp.id,'futa',v),off)}</td>
                          <td>{taxInput(t.suta,v=>setTax(emp.id,'suta',v),off)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* 10/12 (Nic, ledger P7): work-trade extra hours sent to GAM Books. */}
          {(w2.length>0||contractor.length>0)&&(
            <div className="card" style={{marginBottom:16}}>
              <div className="ct">Work-trade extra hours sent to GAM Books</div>
              <div style={{fontSize:'.72rem',color:'var(--t3)',marginBottom:12}}>Extra hours a work trader worked that the landlord chose to pay. Payroll (W-2) hours go on this run as their own paycheck; contractor (1099) hours become an unpaid contractor bill on Expenses.</div>
              {w2.length>0&&(
                <div style={{overflowX:'auto',marginBottom:contractor.length?16:0}}>
                  <table className="tbl" style={{minWidth:960}}>
                    <thead><tr><th style={{width:40}}></th><th>Work trader</th><th>Hours</th><th>Pay</th><th>Employee record</th><th>Federal W/H</th><th>State W/H</th><th>Federal unemp.</th><th>State unemp.</th></tr></thead>
                    <tbody>
                      {w2.map((x:any)=>{
                        const off=!extraOn[x.id]
                        const t=extraTax[x.id]??NO_TAXES
                        return(
                          <tr key={x.id}>
                            <td><input type="checkbox" aria-label={`Pay ${traderName(x)} on this run`} checked={!off} onChange={()=>setExtraOn(m=>({...m,[x.id]:!m[x.id]}))} disabled={!!x.draftRunId} style={{width:'auto',cursor:'pointer'}}/></td>
                            <td><div style={{fontWeight:600,color:'var(--t0)'}}>{traderName(x)}</div><div style={{fontSize:'.68rem',color:'var(--t3)'}}>{monthOf(x.periodMonth)} · {payMethodLabel(x.payMethod)}{x.draftRunId?' · on a draft run — void it in Pay History to change':''}</div></td>
                            <td className="mono">{x.hours} × {formatCurrency(x.rate)}</td>
                            <td className="mono" style={{color:'var(--green)'}}>{formatCurrency(x.amount)}</td>
                            <td>
                              <select value={empFor(x)} onChange={e=>setExtraEmp(m=>({...m,[x.id]:e.target.value}))} disabled={off} style={{minWidth:160}}>
                                <option value="">Choose…</option>
                                {active.map((e:any)=><option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
                              </select>
                            </td>
                            <td>{taxInput(t.federal,v=>setExtraTaxField(x.id,'federal',v),off)}</td>
                            <td>{taxInput(t.state,v=>setExtraTaxField(x.id,'state',v),off)}</td>
                            <td>{taxInput(t.futa,v=>setExtraTaxField(x.id,'futa',v),off)}</td>
                            <td>{taxInput(t.suta,v=>setExtraTaxField(x.id,'suta',v),off)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  {active.length===0&&<div style={{fontSize:'.72rem',color:'var(--amber)',marginTop:6}}>Add the work trader as an employee first (<Link to={booksPath('employees')}>Employees</Link>).</div>}
                </div>
              )}
              {contractor.map((x:any)=>(
                <div key={x.id} style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:12,flexWrap:'wrap',padding:'10px 0',borderTop:'1px solid var(--b0)'}}>
                  <div style={{minWidth:200}}>
                    <div style={{fontWeight:600,color:'var(--t0)'}}>{traderName(x)} · {formatCurrency(x.amount)}</div>
                    <div style={{fontSize:'.68rem',color:'var(--t3)'}}>{monthOf(x.periodMonth)} · {x.hours} hours × {formatCurrency(x.rate)} · {payMethodLabel(x.payMethod)}</div>
                  </div>
                  <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                    <select aria-label={`Vendor ${traderName(x)} is paid as`} value={contractorVendor[x.id]??''} onChange={e=>setContractorVendor(m=>({...m,[x.id]:e.target.value}))} style={{minWidth:200}}>
                      <option value="">{traderName(x)} (contractor)</option>
                      {(vendors as any[]).map((v:any)=><option key={v.id} value={v.id}>{v.name}</option>)}
                    </select>
                    <button type="button" className="btn bp bsm" disabled={recording===x.id||(asked&&!costPlaceChosen(contractorPlace[x.id]??BLANK_COST_PLACE))} onClick={()=>recordContractor(x)}>{recording===x.id?<><span className="spinner"/>Recording…</>:'Record contractor bill'}</button>
                  </div>
                  {asked&&<div style={{flexBasis:'100%'}}>
                    <CostPlaceField value={contractorPlace[x.id]??BLANK_COST_PLACE} onChange={v=>setContractorPlace(m=>({...m,[x.id]:v}))}
                      properties={properties} what={`${traderName(x)}'s contractor bill`} name={`contractorPlace-${x.id}`}/>
                  </div>}
                </div>
              ))}
            </div>
          )}

          {asked&&<div className="card" style={{marginBottom:16}}>
            <CostPlaceField value={place} onChange={setPlace} properties={properties} what="this payroll's cost (wages and employer taxes)" name="payrollPlace"/>
          </div>}

          <div style={{display:'flex',justifyContent:'flex-end'}}>
            <button type="submit" className="btn bp" disabled={calculating||!canCalc} style={{padding:'10px 24px',fontSize:'.9rem'}}>
              {calculating?<><span className="spinner"/>Calculating…</>:`Calculate Payroll for ${selectedIds.length+extraChosen.length} Paycheck${selectedIds.length+extraChosen.length!==1?'s':''} →`}
            </button>
          </div>
        </form>
      )}

      {/* STEP 2 — REVIEW */}
      {step==='review'&&draftRun&&(
        <div>
          <div className="grid4" style={{marginBottom:16}}>
            <div className="kpi"><div className="kl">Total Gross Pay</div><div className="kv gold">{formatCurrency(draftRun.totalGross)}</div><div className="ks">{draftRun.employeeCount} employees · {fmtFreq(draftRun.payFrequency)}</div></div>
            <div className="kpi"><div className="kl">Withheld</div><div className="kv r">{formatCurrency((+draftRun.totalFederalTax)+(+draftRun.totalStateTax)+(+draftRun.totalSs)+(+draftRun.totalMedicare))}</div><div className="ks">Fed + State + SS + Medicare</div></div>
            <div className="kpi"><div className="kl">Total Net Pay</div><div className="kv g">{formatCurrency(draftRun.totalNet)}</div><div className="ks">Employee take-home</div></div>
            <div className="kpi"><div className="kl">Pay Date</div><div className="kv b" style={{fontSize:'1.1rem'}}>{new Date(draftRun.payDate+'T12:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</div><div className="ks">Period: {new Date(draftRun.periodStart+'T12:00:00').toLocaleDateString()} – {new Date(draftRun.periodEnd+'T12:00:00').toLocaleDateString()}</div></div>
          </div>

          <div className="card" style={{marginBottom:16,padding:0}}>
            <div style={{padding:'12px 16px',borderBottom:'1px solid var(--b1)'}}><div className="ct" style={{marginBottom:0}}>Pay Run Breakdown</div></div>
            <div style={{overflowX:'auto'}}>
              <table className="tbl" style={{minWidth:760}}>
                <thead><tr><th>Employee</th><th>Pay Type</th><th>Gross</th><th>Federal W/H</th><th>SS (6.2%)</th><th>Medicare</th><th>State</th><th>Net Pay</th></tr></thead>
                <tbody>
                  {draftRun.lines?.map((line:any)=>(
                    <tr key={line.id}>
                      <td><div style={{fontWeight:600,color:'var(--t0)'}}>{line.firstName} {line.lastName}</div><div style={{fontSize:'.68rem',color:'var(--t3)'}}>{line.memo||line.title||''}{line.hoursWorked?' · '+line.hoursWorked+' hrs':''}</div></td>
                      <td><span className={`badge ${line.payType==='salary'?'bb':'ba'}`}>{(BOOKS_PAY_TYPE_LABEL as Record<string,string>)[line.payType]??humanize(line.payType)}</span></td>
                      <td className="mono" style={{color:'var(--t0)',fontWeight:600}}>{formatCurrency(line.grossPay)}</td>
                      <td className="mono" style={{color:'var(--red)'}}>{formatCurrency(line.federalTax)}</td>
                      <td className="mono" style={{color:'var(--amber)'}}>{formatCurrency(line.ssTax)}</td>
                      <td className="mono" style={{color:'var(--amber)'}}>{formatCurrency(line.medicareTax)}</td>
                      <td className="mono" style={{color:'var(--amber)'}}>{formatCurrency(line.stateTax)}</td>
                      <td className="mono" style={{color:'var(--green)',fontWeight:700}}>{formatCurrency(line.netPay)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{background:'var(--bg3)'}}>
                    <td colSpan={2} style={{padding:'10px 12px',fontWeight:700,color:'var(--t0)',fontFamily:'var(--font-d)'}}>TOTALS</td>
                    <td className="mono" style={{fontWeight:700,color:'var(--gold)',padding:'10px 12px'}}>{formatCurrency(draftRun.totalGross)}</td>
                    <td className="mono" style={{color:'var(--red)',padding:'10px 12px'}}>{formatCurrency(draftRun.totalFederalTax)}</td>
                    <td className="mono" style={{color:'var(--amber)',padding:'10px 12px'}}>{formatCurrency(draftRun.totalSs)}</td>
                    <td className="mono" style={{color:'var(--amber)',padding:'10px 12px'}}>{formatCurrency(draftRun.totalMedicare)}</td>
                    <td className="mono" style={{color:'var(--amber)',padding:'10px 12px'}}>{formatCurrency(draftRun.totalStateTax)}</td>
                    <td className="mono" style={{fontWeight:700,color:'var(--green)',padding:'10px 12px'}}>{formatCurrency(draftRun.totalNet)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <div className="card" style={{marginBottom:16}}>
            <div className="ct">Employer taxes (this run)</div>
            {/* 10/12 (Nic, ledger P7): recorded on each paycheck by the server. */}
            <div className="dr"><span className="dk">Employer Social Security (6.2%)</span><span className="dv mono" style={{color:'var(--amber)'}}>{formatCurrency(draftRun.totalEmployerSs)}</span></div>
            <div className="dr"><span className="dk">Employer Medicare (1.45%)</span><span className="dv mono" style={{color:'var(--amber)'}}>{formatCurrency(draftRun.totalEmployerMedicare)}</span></div>
            <div className="dr"><span className="dk">Federal unemployment</span><span className="dv mono" style={{color:'var(--amber)'}}>{formatCurrency(draftRun.totalFuta)}</span></div>
            <div className="dr"><span className="dk">State unemployment</span><span className="dv mono" style={{color:'var(--amber)'}}>{formatCurrency(draftRun.totalSuta)}</span></div>
            <div className="dr"><span className="dk">Total employer tax cost</span><span className="dv mono" style={{color:'var(--red)',fontWeight:700}}>{formatCurrency(employerTaxes)}</span></div>
            <div className="dr"><span className="dk">Total cost to employer (gross + employer taxes)</span><span className="dv mono" style={{color:'var(--gold)',fontWeight:700}}>{formatCurrency((+draftRun.totalGross)+employerTaxes)}</span></div>
            {asked&&<div className="dr"><span className="dk">Wages and employer taxes go to</span><span className="dv">{runPlaceWords(draftRun)}</span></div>}
          </div>

          <div style={{display:'flex',gap:12,justifyContent:'flex-end',flexWrap:'wrap'}}>
            <button className="btn bd" onClick={()=>discardDraft(true)}>Void Draft</button>
            <button className="btn bp" onClick={approve} disabled={approving} style={{padding:'10px 28px',fontSize:'.9rem'}}>
              {approving?<><span className="spinner"/>Approving…</>:'✓ Approve & Post Payroll'}
            </button>
          </div>
        </div>
      )}

      {/* STEP 3 — DONE */}
      {step==='done'&&(
        <div className="card" style={{textAlign:'center',padding:'60px 20px'}}>
          <div style={{fontSize:'3rem',marginBottom:16}}>✅</div>
          <h2 style={{color:'var(--green)',marginBottom:8}}>Payroll Approved!</h2>
          <p style={{color:'var(--t2)',marginBottom:4}}>Total gross: <strong style={{color:'var(--t0)'}}>{formatCurrency(draftRun?.totalGross)}</strong></p>
          <p style={{color:'var(--t2)',marginBottom:24}}>Net pay: <strong style={{color:'var(--green)'}}>{formatCurrency(draftRun?.totalNet)}</strong> for {draftRun?.employeeCount} employee{draftRun?.employeeCount!==1?'s':''}</p>
          <p style={{color:'var(--t3)',fontSize:'.8rem',marginBottom:24}}>It is booked on the pay date. Each paycheck's take-home pay and the payroll taxes are on Expenses as unpaid bills, ready to match the bank lines that pay them.</p>
          <div style={{display:'flex',gap:12,justifyContent:'center',flexWrap:'wrap'}}>
            <button className="btn bp" onClick={()=>{setStep('setup');setDraftRun(null);setSelectedIds([]);setHoursMap({});setTaxMap({});setExtraOn({});setExtraTax({});setPlace(BLANK_COST_PLACE)}}>Run Another Payroll</button>
            <Link to={booksPath('payHistory')} className="btn bp">View Pay History →</Link>
          </div>
        </div>
      )}
    </div>
  )
}
