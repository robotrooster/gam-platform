/**
 * 10/12 (Nic): Close Month — "close/reopen month: landlord's choice (owner
 * decides who can close and reopen)" (L3). Closing is optional.
 *
 * A closed month's numbers stop changing: anything dated in it afterwards
 * (a late bank match, a backdated payment, a fix) still happens and shows as a
 * correction in the next open month. Before a month closes, the checklist
 * (services/ledgerClose) must be clear — nothing still waiting to post, every
 * books check tied out, every linked bank account reconciled through the
 * month's end. Warnings (bank lines not filed, money in Suspense, bills past
 * due, a bank account with no feed not reconciled) never block; the close
 * keeps what it was warned about. Reopening a month reopens every later one
 * and always says why. Who may close and who may reopen is the company's
 * Books Settings choice; there is no automatic close.
 *
 * GAM Books' own page, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts). How it reaches the API, shows a toast and
 * links to another Books page is the app's own (./adapter).
 */
import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from 'react-query'
import {
  LEDGER_CLOSE_PERMISSION_LABEL, LEDGER_CLOSE_ACTION_LABEL, LEDGER_CLOSE_WARNING_LABEL,
} from '@gam/shared'
import { booksGet as get, booksPost as post, toast, appConfirm, booksPath } from './adapter'
import { loadErrorText } from './booksMoney'

interface Warning { kind: string; count: number; amount: number; text: string }
interface Status {
  closedThrough: string | null; booksStartDate: string | null; today: string
  closeBy: string; reopenBy: string
  canClose: boolean; closeRefusal: string | null; canReopen: boolean; reopenRefusal: string | null
  nextThrough: string | null; through: string | null; ready: boolean
  blockers: { key: string; text: string }[]
  warnings: Warning[]
  history: { id: string; action: string; closedThrough: string | null; reason: string | null; by: string | null; at: string; warnings: Warning[] }[]
}

const longDay=(d:string|null|undefined)=>d?new Date(`${d.slice(0,10)}T12:00:00`).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'}):'—'
const monthName=(d:string|null|undefined)=>d?new Date(`${d.slice(0,7)}-15T12:00:00`).toLocaleDateString('en-US',{month:'long',year:'numeric'}):'—'
/** 'YYYY-MM' → that month's last day 'YYYY-MM-DD'. */
const monthEnd=(ym:string)=>{const[y,m]=ym.split('-').map(Number);return new Date(Date.UTC(y,m,0)).toISOString().slice(0,10)}
/** The month after the one 'YYYY-MM-DD' falls in, 'YYYY-MM'. */
const nextMonth=(d:string)=>{const[y,m]=d.split('-').map(Number);return new Date(Date.UTC(y,m,1)).toISOString().slice(0,7)}
/** The last month that has ended, 'YYYY-MM'. */
const lastEndedMonth=(today:string)=>{const[y,m]=today.split('-').map(Number);const d=new Date(Date.UTC(y,m-2,1));return d.toISOString().slice(0,7)}
const errText=(ex:any,fallback:string)=>ex?.response?.data?.error||fallback
const permissionLabel=(p:string)=>(LEDGER_CLOSE_PERMISSION_LABEL as Record<string,string>)[p]??'—'
const actionLabel=(a:string)=>(LEDGER_CLOSE_ACTION_LABEL as Record<string,string>)[a]??'—'
const warningLabel=(k:string)=>(LEDGER_CLOSE_WARNING_LABEL as Record<string,string>)[k]??'A warning'

export function CloseMonthPage(){
  const qc=useQueryClient()
  const[month,setMonth]=useState('')   // 'YYYY-MM' chosen; '' = the next one to close
  const through=month?monthEnd(month):''
  const{data:st,isLoading,error,isFetching}=useQuery(['closeStatus',through],()=>get<Status>(`/books/close${through?`?through=${through}`:''}`))
  const[checking,setChecking]=useState(false)
  const[closing,setClosing]=useState(false)
  const[note,setNote]=useState('')
  const show=(next:Status)=>{qc.setQueryData(['closeStatus',through],next);if(!through)qc.invalidateQueries('closeStatus')}

  // Start on the next month to close.
  useEffect(()=>{if(!month&&st?.through)setMonth(st.through.slice(0,7))},[st?.through,month])

  const header=(
    <div className="ph"><div><h1 className="pt">🔒 Close Month</h1><p className="ps">Closing a month stops its numbers from changing. Anything dated in it later still happens, and shows as a correction in the next open month. Closing is optional.</p></div></div>
  )
  if(isLoading)return <div>{header}<div style={{padding:32,textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div></div>
  if(error||!st)return <div>{header}<div className="alert ae">{loadErrorText(error,'Could not load the close checklist.')}</div></div>

  const check=async()=>{
    setChecking(true)
    try{const r=await post<Status>('/books/close/check',{through:st.through});show(r.data)}
    catch(ex:any){toast.error(errText(ex,'Could not check the books.'))}
    finally{setChecking(false)}
  }
  const close=async()=>{
    if(!st.through)return
    const warned=st.warnings.length?` ${st.warnings.length} warning${st.warnings.length!==1?'s':''} will be kept with the close.`:''
    if(!(await appConfirm(`Close the books through ${longDay(st.through)}? Anything dated on or before it will show as a correction in the next open month.${warned}`,{title:'Close the month',confirmLabel:`Close ${monthName(st.through)}`})))return
    setClosing(true)
    try{
      const r=await post<{status:Status}>('/books/close',{through:st.through,note:note.trim()||null})
      toast(`Closed through ${longDay(st.through)}.`)
      setNote('');setMonth('')
      qc.setQueryData(['closeStatus',''],r.data.status)
      qc.invalidateQueries('closeStatus')
    }catch(ex:any){toast.error(errText(ex,'Could not close the month.'))}
    finally{setClosing(false)}
  }
  const maxMonth=lastEndedMonth(st.today)
  const minMonth=st.closedThrough?nextMonth(st.closedThrough):undefined

  return(
    <div>
      {header}
      <div className="grid2" style={{marginBottom:16}}>
        <div className="card">
          <div className="ct">Where the books stand</div>
          <div className="dr"><span className="dk">Closed through</span><span className="dv mono">{st.closedThrough?longDay(st.closedThrough):'Nothing is closed yet'}</span></div>
          <div className="dr"><span className="dk">Books start</span><span className="dv mono">{st.booksStartDate?longDay(st.booksStartDate):'Not chosen yet'}</span></div>
          <div className="dr"><span className="dk">Who may close a month</span><span className="dv">{permissionLabel(st.closeBy)}</span></div>
          <div className="dr"><span className="dk">Who may reopen one</span><span className="dv">{permissionLabel(st.reopenBy)}</span></div>
          <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:8,lineHeight:1.5}}>The owner chooses who may close and reopen in <Link to={booksPath('booksSettings')} style={{color:'var(--gold)'}}>Books Settings</Link>. Banks are reconciled on <Link to={booksPath('reconcile')} style={{color:'var(--gold)'}}>Bank Reconciliation</Link>.</div>
        </div>
        <div className="card">
          <div className="ct">Close a month</div>
          <div className="frow"><label>Month</label>
            <input type="month" value={month} min={minMonth} max={maxMonth} onChange={e=>setMonth(e.target.value)}/>
          </div>
          {!st.through?<div style={{fontSize:'.78rem',color:'var(--t3)'}}>Nothing to close until {st.closedThrough?`the month after ${monthName(st.closedThrough)}`:'this month'} has ended.</div>:(
            <>
              {isFetching&&<div style={{fontSize:'.72rem',color:'var(--t3)',marginBottom:8}}>Checking…</div>}
              {st.blockers.length?(
                <div className="alert ae" style={{flexDirection:'column',gap:4}}>
                  <strong>{monthName(st.through)} cannot close yet:</strong>
                  <ul style={{margin:'2px 0 0 18px',padding:0}}>{st.blockers.map(b=><li key={b.key}>{b.text}</li>)}</ul>
                </div>
              ):<div className="alert ag">Ready: {monthName(st.through)} can close.</div>}
              {st.warnings.length>0&&(
                <div className="alert aw" style={{flexDirection:'column',gap:4}}>
                  <strong>Worth a look first (these never stop a close):</strong>
                  <ul style={{margin:'2px 0 0 18px',padding:0}}>{st.warnings.map(w=><li key={w.kind}><span style={{fontWeight:600}}>{warningLabel(w.kind)}.</span> {w.text}</li>)}</ul>
                </div>
              )}
              <div className="frow"><label>Note (optional)</label><input value={note} onChange={e=>setNote(e.target.value)} maxLength={500} placeholder="e.g. Statements reconciled, bills entered"/></div>
              {!st.canClose&&<div style={{fontSize:'.76rem',color:'var(--t3)',marginBottom:8}}>{st.closeRefusal}</div>}
              <div className="factions" style={{flexWrap:'wrap'}}>
                <button className="btn bp bsm" onClick={check} disabled={checking||closing}>{checking?<><span className="spinner"/>Checking…</>:'Check again'}</button>
                <button className="btn bp" onClick={close} disabled={closing||checking||!st.ready||!st.canClose}>{closing?<><span className="spinner"/>Closing…</>:`Close ${monthName(st.through)}`}</button>
              </div>
            </>
          )}
        </div>
      </div>

      {st.closedThrough&&<Reopen st={st} onDone={()=>{setMonth('');qc.invalidateQueries('closeStatus')}}/>}

      <div className="card" style={{padding:0}}>
        <div style={{padding:'12px 16px',borderBottom:'1px solid var(--b1)'}}><div className="ct" style={{marginBottom:0}}>History</div></div>
        <div style={{overflowX:'auto'}}>
          <table className="tbl" style={{minWidth:520}}>
            <thead><tr><th>When</th><th>What</th><th>Through</th><th>By</th><th>Why / note</th></tr></thead>
            <tbody>
              {st.history.length?st.history.map(h=>(
                <tr key={h.id}>
                  <td className="mono" style={{fontSize:'.72rem',whiteSpace:'nowrap'}}>{new Date(h.at).toLocaleString()}</td>
                  <td><span className={`badge ${h.action==='close'?'bg2':'ba'}`}>{actionLabel(h.action)}</span></td>
                  <td className="mono" style={{fontSize:'.74rem'}}>{h.closedThrough?longDay(h.closedThrough):'Nothing stays closed'}</td>
                  <td style={{fontSize:'.74rem'}}>{h.by??'—'}</td>
                  <td style={{fontSize:'.74rem'}}>
                    {h.reason??''}
                    {h.warnings.length>0&&<div style={{color:'var(--amber)',marginTop:2}}>Closed with: {h.warnings.map(w=>warningLabel(w.kind).toLowerCase()).join('; ')}</div>}
                  </td>
                </tr>
              )):<tr><td colSpan={5}><div className="empty">No month has been closed.</div></td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function Reopen({st,onDone}:{st:Status;onDone:()=>void}){
  const[month,setMonth]=useState(st.closedThrough!.slice(0,7))
  const[reason,setReason]=useState('')
  const[saving,setSaving]=useState(false)
  useEffect(()=>{setMonth(st.closedThrough!.slice(0,7))},[st.closedThrough])
  const minMonth=st.booksStartDate?st.booksStartDate.slice(0,7):undefined
  const go=async(e:React.FormEvent)=>{
    e.preventDefault()
    if(!(await appConfirm(`Reopen ${monthName(`${month}-01`)}${month<st.closedThrough!.slice(0,7)?' and every month after it':''}? Fixes dated in ${month<st.closedThrough!.slice(0,7)?'them':'it'} will change ${month<st.closedThrough!.slice(0,7)?'those months':'that month'} again.`,{title:'Reopen a month',confirmLabel:'Reopen'})))return
    setSaving(true)
    try{
      await post('/books/close/reopen',{month:`${month}-01`,reason:reason.trim()})
      toast(`${monthName(`${month}-01`)} is open again.`)
      setReason('');onDone()
    }catch(ex:any){toast.error(errText(ex,'Could not reopen the month.'))}
    finally{setSaving(false)}
  }
  return(
    <div className="card" style={{marginBottom:16}}>
      <div className="ct">Reopen a month</div>
      {!st.canReopen?<div style={{fontSize:'.78rem',color:'var(--t3)'}}>{st.reopenRefusal}</div>:(
        <form onSubmit={go}>
          <div className="grid2">
            <div className="frow"><label>Month to reopen (and every later one)</label><input type="month" value={month} min={minMonth} max={st.closedThrough!.slice(0,7)} onChange={e=>setMonth(e.target.value)} required/></div>
            <div className="frow"><label>Why</label><input value={reason} onChange={e=>setReason(e.target.value)} maxLength={500} required placeholder="e.g. A bill for September arrived late"/></div>
          </div>
          <button type="submit" className="btn bp" disabled={saving||!month||!reason.trim()}>{saving?<><span className="spinner"/>Reopening…</>:'Reopen'}</button>
        </form>
      )}
    </div>
  )
}
