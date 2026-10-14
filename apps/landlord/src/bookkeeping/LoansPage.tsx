/**
 * 10/12 (Nic): "loans/mortgages (principal / interest / escrow per payment)".
 * The loan register: each loan, what is still owed, the escrow the lender
 * holds, and every payment split three ways — principal (what is owed goes
 * down), interest (an expense) and escrow (money the lender holds to pay the
 * property tax and insurance). A payment is typed here, or made from a bank
 * line on the Bank page.
 *
 * 10/13 (Nic): "each expense is chosen on the split or specific unit or
 * property at the time of logging. there should never be a default setting to
 * apply expenses." A loan says where its interest goes when it is logged —
 * split across the properties by units, one property, or one unit
 * (CostPlaceField); the form does not save until that is answered. And
 * "they don't pick as a setting, they pick as the expense happens": where the
 * loan's money went and what each payment was paid from start blank too.
 *
 * GAM Books' own page, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts). How it reaches the API, shows a toast and
 * links to another Books page is the app's own (./adapter).
 */
import React, { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from 'react-query'
import {
  formatCurrency, BOOKS_LOAN_FUNDED_TO, BOOKS_LOAN_FUNDED_TO_LABEL, BOOKS_LOAN_PAYMENT_METHODS, BOOKS_LOAN_PAYMENT_METHOD_LABEL,
  BOOKS_LOAN_STATE_LABEL, BOOKS_COST_PLACE_NONE_LABEL, BOOKS_COST_PLACE_LABEL,
} from '@gam/shared'
import { booksGet as get, booksPost as post, booksPatch as patch, toast } from './adapter'
import { Modal } from './common'
import { VoidReasonModal } from './VoidReasonModal'
import { CostPlaceField, useCostPlaces, costPlaceOf, costPlaceChosen, costPlaceBody, type CostPlaceValue, type CostPlaceProperty } from './CostPlaceField'

const day=(d:string|null|undefined)=>d?new Date(`${d.slice(0,10)}T12:00:00`).toLocaleDateString():'—'
const stateLabel=(s:string)=>(BOOKS_LOAN_STATE_LABEL as Record<string,string>)[s]??'—'
const methodLabel=(m:string)=>(BOOKS_LOAN_PAYMENT_METHOD_LABEL as Record<string,string>)[m]??'—'
const fundedLabel=(f:string)=>(BOOKS_LOAN_FUNDED_TO_LABEL as Record<string,string>)[f]??'—'
const money=(n:number)=>Math.round(n*100)/100
// 10/13 (Nic): where a loan's interest goes, in words, for its row.
const placeWords=(l:any)=>l.costPlace==='split_by_units'?BOOKS_COST_PLACE_LABEL.split_by_units
  :l.unitNumber?`${l.propertyName??''} · Unit ${l.unitNumber}`:(l.propertyName??BOOKS_COST_PLACE_NONE_LABEL)

const blankLoan={name:'',lenderName:'',vendorId:'',originalAmount:'',annualRate:'',startDate:'',termMonths:'',
  paymentAmount:'',escrowAmount:'0',paymentDay:'',fundedTo:'',fundedBankConnectionId:'',openingBalance:'',openingEscrow:'',notes:''}
type LoanForm=typeof blankLoan

export function LoansPage(){
  const qc=useQueryClient()
  const[showVoided,setShowVoided]=useState(false)
  const{data:loans=[],isLoading}=useQuery(['loans',showVoided],()=>get<any[]>(`/books/loans${showVoided?'?includeVoided=true':''}`))
  const{data:opts}=useQuery('loanOpts',()=>get<any>('/books/loans/form-options'))
  const{properties,asked}=useCostPlaces()
  const{data:vendors=[]}=useQuery(['ven',false],()=>get<any[]>('/books/vendors'))
  const[editing,setEditing]=useState<any|null|'new'>(null)
  const[openId,setOpenId]=useState<string|null>(null)

  const live=(loans as any[]).filter(l=>l.state!=='voided')
  const owed=live.reduce((s,l)=>s+(+l.balance||0),0)
  const escrow=live.reduce((s,l)=>s+(+l.escrowHeld||0),0)
  const interest=live.reduce((s,l)=>s+(+l.interestPaid||0),0)
  const refresh=()=>{qc.invalidateQueries('loans');qc.invalidateQueries('loan')}

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">🏦 Loans</h1><p className="ps">Mortgages and other loans. Each payment splits into principal (what you owe goes down), interest (an expense) and escrow (money your lender holds to pay property tax and insurance).</p></div>
        <button className="btn bp" onClick={()=>setEditing('new')}>+ Add Loan</button>
      </div>

      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">Owed on Your Loans</div><div className="kv r">{formatCurrency(owed)}</div><div className="ks">{live.filter(l=>l.state==='active').length} being paid</div></div>
        <div className="kpi"><div className="kl">Escrow Lenders Hold</div><div className="kv t">{formatCurrency(escrow)}</div><div className="ks">For property tax and insurance</div></div>
        <div className="kpi"><div className="kl">Interest Paid</div><div className="kv gold">{formatCurrency(interest)}</div><div className="ks">Since your books start</div></div>
        <div className="kpi"><div className="kl">Books Start</div><div className="kv">{opts?.booksStartDate?day(opts.booksStartDate):'Not set'}</div><div className="ks">A loan made before it opens at what was owed that day</div></div>
      </div>

      <div style={{display:'flex',justifyContent:'flex-end',marginBottom:8}}>
        <label style={{display:'flex',alignItems:'center',gap:6,fontSize:'.75rem',textTransform:'none',letterSpacing:0,color:'var(--t2)',marginBottom:0}}>
          <input type="checkbox" checked={showVoided} onChange={e=>setShowVoided(e.target.checked)} style={{width:'auto'}}/> Show voided
        </label>
      </div>

      <div className="card" style={{padding:0}}>
        {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
          <div style={{overflowX:'auto'}}>
            <table className="tbl" style={{minWidth:640}}>
              <thead><tr><th>Loan</th><th>Interest goes to</th><th>Rate</th><th>Payment</th><th>Owed now</th><th>Escrow held</th><th>Last paid</th><th></th></tr></thead>
              <tbody>
                {(loans as any[]).length?(loans as any[]).map((l:any)=>(
                  <tr key={l.id} style={{opacity:l.state==='voided'?.5:1}}>
                    <td>
                      <div style={{fontWeight:600,color:'var(--t0)'}}>{l.name}</div>
                      <div style={{fontSize:'.68rem',color:'var(--t3)'}}>{l.lenderName} · <span className={`badge ${l.state==='active'?'bteal':l.state==='paid_off'?'bg2':'bmu'}`}>{stateLabel(l.state)}</span></div>
                    </td>
                    <td style={{fontSize:'.75rem'}}>{placeWords(l)}</td>
                    <td className="mono">{(+l.annualRate).toFixed(3).replace(/\.?0+$/,'')}%</td>
                    <td className="mono">{l.paymentAmount?formatCurrency(l.paymentAmount):'—'}{+l.escrowAmount>0&&<div style={{fontSize:'.62rem',color:'var(--t3)'}}>{formatCurrency(l.escrowAmount)} escrow</div>}</td>
                    <td className="mono" style={{color:'var(--red)'}}>{l.balance==null?<span className="badge ba">Enter what was owed</span>:formatCurrency(l.balance)}</td>
                    <td className="mono">{formatCurrency(l.escrowHeld)}</td>
                    <td style={{fontSize:'.72rem'}}>{day(l.lastPaidOn)}</td>
                    <td><button className="btn bp bsm" onClick={()=>setOpenId(l.id)}>Open</button></td>
                  </tr>
                )):<tr><td colSpan={8}><div className="empty">No loans yet. Add a mortgage or any other loan the company is paying.</div></td></tr>}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing&&<LoanFormModal loan={editing==='new'?null:editing} opts={opts} properties={properties} asked={asked} vendors={vendors as any[]}
        onClose={()=>setEditing(null)} onSaved={(id)=>{refresh();setEditing(null);setOpenId(id)}}/>}
      {openId&&!editing&&<LoanDetail id={openId} onClose={()=>setOpenId(null)} onEdit={(l)=>setEditing(l)} onChanged={refresh} opts={opts}/>}
    </div>
  )
}

function LoanFormModal({loan,opts,properties,asked,vendors,onClose,onSaved}:{loan:any|null;opts:any;properties:CostPlaceProperty[];asked:boolean;vendors:any[];onClose:()=>void;onSaved:(id:string)=>void}){
  // 10/13 (Nic): where its interest goes — asked, never chosen for the person.
  const[place,setPlace]=useState<CostPlaceValue>(()=>costPlaceOf(loan))
  const[form,setForm]=useState<LoanForm>(()=>loan?{
    name:loan.name??'',lenderName:loan.lenderName??'',vendorId:loan.vendorId??'',
    originalAmount:String(+loan.originalAmount),annualRate:String(+loan.annualRate),startDate:loan.startDate??'',
    termMonths:loan.termMonths?String(loan.termMonths):'',paymentAmount:loan.paymentAmount?String(+loan.paymentAmount):'',
    escrowAmount:String(+loan.escrowAmount||0),paymentDay:loan.paymentDay?String(loan.paymentDay):'',fundedTo:loan.fundedTo??'',
    fundedBankConnectionId:loan.fundedBankConnectionId??'',openingBalance:loan.openingBalance!=null?String(+loan.openingBalance):'',
    openingEscrow:loan.openingEscrow!=null?String(+loan.openingEscrow):'',notes:loan.notes??''}:blankLoan)
  const[err,setErr]=useState('')
  const[saving,setSaving]=useState(false)
  const set=(k:keyof LoanForm)=>(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>)=>setForm(p=>({...p,[k]:e.target.value}))
  const start:string|null=opts?.booksStartDate??null
  const before=!!start&&!!form.startDate&&form.startDate<start
  const save=async(e:React.FormEvent)=>{
    e.preventDefault();setSaving(true);setErr('')
    const body:any={...form,fundedTo:before?'':form.fundedTo,fundedBankConnectionId:!before&&form.fundedTo==='bank'?form.fundedBankConnectionId:'',
      openingBalance:before?form.openingBalance:'',openingEscrow:before?form.openingEscrow:'',...(asked?costPlaceBody(place):{})}
    try{
      const r=loan?await patch(`/books/loans/${loan.id}`,body):await post('/books/loans',body)
      toast(loan?'Loan saved.':`${form.name} added.`)
      onSaved((r.data as any).id)
    }catch(ex:any){setErr(ex.response?.data?.error||'Could not save the loan.')}
    finally{setSaving(false)}
  }
  return(
    <Modal title={loan?`Edit ${loan.name}`:'Add Loan'} onClose={onClose}>
      {err&&<div className="alert ae">{err}</div>}
      <form onSubmit={save}>
        <div className="frow2">
          <div><label>Name of the loan</label><input type="text" value={form.name} onChange={set('name')} maxLength={120} required placeholder="e.g. Oak Street mortgage"/></div>
          <div><label>Lender</label><input type="text" value={form.lenderName} onChange={set('lenderName')} maxLength={200} required/></div>
        </div>
        {asked&&<CostPlaceField value={place} onChange={setPlace} properties={properties} what="its interest"/>}
        <div className="frow"><label>Lender on your vendor list (optional)</label>
          <select value={form.vendorId} onChange={set('vendorId')}>
            <option value="">None</option>
            {vendors.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </div>
        <div className="frow2">
          <div><label>Amount borrowed</label><input type="number" min="0.01" step="0.01" value={form.originalAmount} onChange={set('originalAmount')} required/></div>
          <div><label>Yearly interest rate (%)</label><input type="number" min="0" max="99.9999" step="0.0001" value={form.annualRate} onChange={set('annualRate')} required/></div>
        </div>
        <div className="frow2">
          <div><label>Day the loan was made</label><input type="date" value={form.startDate} onChange={set('startDate')} required/></div>
          <div><label>Term in months (optional)</label><input type="number" min="1" max="600" step="1" value={form.termMonths} onChange={set('termMonths')}/></div>
        </div>
        <div className="frow2">
          <div><label>Regular payment (with escrow)</label><input type="number" min="0.01" step="0.01" value={form.paymentAmount} onChange={set('paymentAmount')}/></div>
          <div><label>Escrow part of each payment</label><input type="number" min="0" step="0.01" value={form.escrowAmount} onChange={set('escrowAmount')}/></div>
        </div>
        <div className="frow"><label>Day of the month it is due (optional)</label><input type="number" min="1" max="31" step="1" value={form.paymentDay} onChange={set('paymentDay')}/></div>
        {before?(
          <div className="card" style={{background:'var(--bg3)',marginBottom:14}}>
            <p style={{fontSize:'.78rem',color:'var(--t2)',marginBottom:10}}>This loan was made before your books start ({day(start)}). Enter what your lender's statement says was still owed that day, and the escrow they held.</p>
            <div className="frow2" style={{marginBottom:0}}>
              <div><label>Still owed on {day(start)}</label><input type="number" min="0" step="0.01" value={form.openingBalance} onChange={set('openingBalance')} required/></div>
              <div><label>Escrow held that day</label><input type="number" min="0" step="0.01" value={form.openingEscrow} onChange={set('openingEscrow')}/></div>
            </div>
          </div>
        ):(
          <div className="frow2">
            <div><label>Where the money went</label>
              <select value={form.fundedTo} onChange={set('fundedTo')} required>
                <option value="">Choose where the money went</option>
                {BOOKS_LOAN_FUNDED_TO.map(f=><option key={f} value={f}>{fundedLabel(f)}</option>)}
              </select>
            </div>
            {form.fundedTo==='bank'&&<div><label>Bank account</label>
              <select value={form.fundedBankConnectionId} onChange={set('fundedBankConnectionId')}>
                <option value="">Not one linked to GAM</option>
                {(opts?.bankAccounts??[]).map((b:any)=><option key={b.id} value={b.id}>{b.name}{b.accountLast4?` ••${b.accountLast4}`:''}</option>)}
              </select>
            </div>}
          </div>
        )}
        <div className="frow"><label>Notes (optional)</label><textarea rows={2} value={form.notes} onChange={set('notes')}/></div>
        <div className="factions">
          <button type="button" className="btn bg-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn bp" disabled={saving||(asked&&!costPlaceChosen(place))||(!before&&!form.fundedTo)}>{saving?<><span className="spinner"/>Saving…</>:loan?'Save':'Add Loan'}</button>
        </div>
      </form>
    </Modal>
  )
}

function LoanDetail({id,opts,onClose,onEdit,onChanged}:{id:string;opts:any;onClose:()=>void;onEdit:(l:any)=>void;onChanged:()=>void}){
  const qc=useQueryClient()
  const{data:loan}=useQuery(['loan',id],()=>get<any>(`/books/loans/${id}`))
  const today:string=opts?.today??new Date().toISOString().slice(0,10)
  // 10/13 (Nic): what it was paid from is picked on each payment, never preselected.
  const[pay,setPay]=useState({paidOn:today,amount:'',principal:'',interest:'',escrow:'',method:'',bankConnectionId:'',memo:''})
  const[hint,setHint]=useState<any>(null)
  const[err,setErr]=useState('')
  const[saving,setSaving]=useState(false)
  const[voiding,setVoiding]=useState<null|{kind:'loan'}|{kind:'payment';p:any}>(null)
  const setP=(k:keyof typeof pay)=>(e:React.ChangeEvent<HTMLInputElement|HTMLSelectElement>)=>setPay(p=>({...p,[k]:e.target.value}))

  useEffect(()=>{if(loan&&!pay.amount&&loan.paymentAmount)setPay(p=>({...p,amount:String(+loan.paymentAmount)}))},[loan])
  useEffect(()=>{
    if(!loan||!pay.paidOn||!(+pay.amount>0))return
    let gone=false
    get<any>(`/books/loans/${id}/suggest?paidOn=${pay.paidOn}&amount=${+pay.amount}`).then(s=>{if(!gone)setHint(s)}).catch(()=>{})
    return()=>{gone=true}
  },[loan?.id,pay.paidOn,pay.amount])
  const useHint=()=>hint&&setPay(p=>({...p,principal:String(hint.principal),interest:String(hint.interest),escrow:String(hint.escrow)}))
  const parts=money((+pay.principal||0)+(+pay.interest||0)+(+pay.escrow||0))

  const record=async(e:React.FormEvent)=>{
    e.preventDefault();setSaving(true);setErr('')
    try{
      await post(`/books/loans/${id}/payments`,{...pay,amount:+pay.amount,principal:+pay.principal||0,interest:+pay.interest||0,escrow:+pay.escrow||0,
        bankConnectionId:pay.method==='bank'?pay.bankConnectionId:''})
      toast('Payment recorded.')
      setPay(p=>({...p,principal:'',interest:'',escrow:'',memo:'',method:'',bankConnectionId:''}))
      qc.invalidateQueries(['loan',id]);onChanged()
    }catch(ex:any){setErr(ex.response?.data?.error||'Could not record the payment.')}
    finally{setSaving(false)}
  }

  if(!loan)return<Modal title="Loan" onClose={onClose}><div style={{padding:24,textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div></Modal>
  const voided=loan.state==='voided'
  return(
    <Modal title={loan.name} onClose={onClose}>
      <div className="dr"><span className="dk">Lender</span><span className="dv">{loan.lenderName}{loan.vendorName?` (${loan.vendorName})`:''}</span></div>
      <div className="dr"><span className="dk">Interest goes to</span><span className="dv">{placeWords(loan)}</span></div>
      <div className="dr"><span className="dk">Borrowed</span><span className="dv mono">{formatCurrency(loan.originalAmount)} on {day(loan.startDate)}</span></div>
      {loan.opensAtBooksStart?
        <div className="dr"><span className="dk">Owed on your books start</span><span className="dv mono">{loan.openingBalance!=null?formatCurrency(loan.openingBalance):'Not entered yet'}</span></div>:
        <div className="dr"><span className="dk">Where the money went</span><span className="dv">{loan.fundedTo?fundedLabel(loan.fundedTo):'Not entered yet'}</span></div>}
      <div className="dr"><span className="dk">Owed now</span><span className="dv mono" style={{color:'var(--red)',fontWeight:700}}>{loan.balance==null?'—':formatCurrency(loan.balance)}</span></div>
      <div className="dr"><span className="dk">Escrow the lender holds</span><span className="dv mono">{formatCurrency(loan.escrowHeld)}</span></div>
      <div className="dr"><span className="dk">Principal / interest paid</span><span className="dv mono">{formatCurrency(loan.principalPaid)} / {formatCurrency(loan.interestPaid)}</span></div>
      {voided&&<div className="alert aw" style={{marginTop:10}}>Voided: {loan.voidReason}</div>}

      {!voided&&(
        <form onSubmit={record} className="card" style={{background:'var(--bg3)',marginTop:14}}>
          <div className="ct">Record a payment</div>
          {err&&<div className="alert ae">{err}</div>}
          <div className="frow2">
            <div><label>Day paid</label><input type="date" value={pay.paidOn} onChange={setP('paidOn')} required/></div>
            <div><label>Payment</label><input type="number" min="0.01" step="0.01" value={pay.amount} onChange={setP('amount')} required/></div>
          </div>
          <div className="grid3" style={{marginBottom:10}}>
            <div><label>Principal</label><input type="number" min="0" step="0.01" value={pay.principal} onChange={setP('principal')}/></div>
            <div><label>Interest</label><input type="number" min="0" step="0.01" value={pay.interest} onChange={setP('interest')}/></div>
            <div><label>Escrow</label><input type="number" min="0" step="0.01" value={pay.escrow} onChange={setP('escrow')}/></div>
          </div>
          {hint&&<div style={{fontSize:'.72rem',color:'var(--t3)',marginBottom:10}}>
            GAM suggests {formatCurrency(hint.principal)} principal, {formatCurrency(hint.interest)} interest, {formatCurrency(hint.escrow)} escrow
            (a month's interest on what is owed). Your lender's statement decides. <button type="button" className="btn bp bsm" onClick={useHint}>Use this split</button>
          </div>}
          {+pay.amount>0&&parts!==money(+pay.amount)&&<div className="alert aw">The parts add up to {formatCurrency(parts)}; they must add up to the payment.</div>}
          <div className="frow2">
            <div><label>Paid from</label>
              <select value={pay.method} onChange={setP('method')} required>
                <option value="">Choose where it came from</option>
                {BOOKS_LOAN_PAYMENT_METHODS.map(m=><option key={m} value={m}>{methodLabel(m)}</option>)}
              </select>
            </div>
            {pay.method==='bank'&&<div><label>Bank account</label>
              <select value={pay.bankConnectionId} onChange={setP('bankConnectionId')}>
                <option value="">Not one linked to GAM</option>
                {(opts?.bankAccounts??[]).map((b:any)=><option key={b.id} value={b.id}>{b.name}{b.accountLast4?` ••${b.accountLast4}`:''}</option>)}
              </select>
            </div>}
          </div>
          <div className="factions" style={{marginTop:0}}>
            <button type="submit" className="btn bp" disabled={saving||parts!==money(+pay.amount)||!pay.method}>{saving?<><span className="spinner"/>Saving…</>:'Record payment'}</button>
          </div>
          <p style={{fontSize:'.68rem',color:'var(--t3)',marginTop:8,marginBottom:0}}>Paid from a linked bank, it matches its bank line when the line arrives. A payment the Bank page made from a line is changed there.</p>
        </form>
      )}

      <div style={{overflowX:'auto',marginTop:14}}>
        <table className="tbl" style={{minWidth:520}}>
          <thead><tr><th>Paid</th><th>Payment</th><th>Principal</th><th>Interest</th><th>Escrow</th><th>From</th><th></th></tr></thead>
          <tbody>
            {(loan.paymentsList??[]).length?(loan.paymentsList as any[]).map(p=>(
              <tr key={p.id} style={{opacity:p.voidedAt?.5:1}}>
                <td style={{fontSize:'.75rem'}}>{day(p.paidOn)}</td>
                <td className="mono">{formatCurrency(p.amount)}</td>
                <td className="mono">{formatCurrency(p.principal)}</td>
                <td className="mono">{formatCurrency(p.interest)}</td>
                <td className="mono">{formatCurrency(p.escrow)}</td>
                <td style={{fontSize:'.7rem'}}>{methodLabel(p.method)}{p.bankTransactionId&&<span className="badge bteal" style={{marginLeft:4}}>Bank line</span>}{p.voidedAt&&<span className="badge bmu" style={{marginLeft:4}}>Voided</span>}</td>
                <td>{!p.voidedAt&&!p.bankTransactionId&&!voided&&<button className="btn bp bsm" onClick={()=>setVoiding({kind:'payment',p})}>Void</button>}</td>
              </tr>
            )):<tr><td colSpan={7}><div className="empty">No payments yet.</div></td></tr>}
          </tbody>
        </table>
      </div>

      <div className="factions">
        {!voided&&<button type="button" className="btn bp" onClick={()=>setVoiding({kind:'loan'})}>Void loan</button>}
        {!voided&&<button type="button" className="btn bp" onClick={()=>onEdit(loan)}>Edit loan</button>}
        <button type="button" className="btn bg-btn" onClick={onClose}>Close</button>
      </div>

      {voiding?.kind==='loan'&&<VoidReasonModal title={`Void ${loan.name}`} what="Void this loan and every payment on it if it was entered by mistake."
        onClose={()=>setVoiding(null)} onVoid={async r=>{await post(`/books/loans/${id}/void`,{reason:r});toast('Loan voided.');qc.invalidateQueries(['loan',id]);onChanged()}}/>}
      {voiding?.kind==='payment'&&<VoidReasonModal title="Void payment" what={`Void the ${formatCurrency(voiding.p.amount)} payment of ${day(voiding.p.paidOn)} if it was entered by mistake.`}
        onClose={()=>setVoiding(null)} onVoid={async r=>{await post(`/books/loans/${id}/payments/${voiding.p.id}/void`,{reason:r});toast('Payment voided.');qc.invalidateQueries(['loan',id]);onChanged()}}/>}
    </Modal>
  )
}
