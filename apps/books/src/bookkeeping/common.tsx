/**
 * 10/12 (Nic): the pieces more than one Books page uses — the form window, the
 * Received / Charged / Owed table, the coming-soon card and a few labels.
 * Same bytes in apps/books and apps/landlord (bookkeeping-parity.test.ts).
 */
import type { ReactNode } from 'react'
import {
  humanize, formatCurrency, MONEY_COLUMNS, MONEY_COLUMN_LABEL,
  BOOKS_CONTRACTOR_TAX_CLASSIFICATION_LABEL, BOOKS_PAY_FREQUENCY_LABEL,
  type MoneyColumn,
} from '@gam/shared'

// ── MODAL ─────────────────────────────────────────────────────────────
export function Modal({title,onClose,children}:{title:string;onClose:()=>void;children:ReactNode}){
  return(
    <div className="overlay" onClick={e=>{if(e.target===e.currentTarget)onClose()}}>
      <div className="modal">
        <div className="modal-h">
          <span className="modal-t">{title}</span>
          <button onClick={onClose} aria-label="Close" style={{background:'none',border:'none',color:'var(--t3)',fontSize:'1.2rem',cursor:'pointer'}}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ── 10/12 (Nic): Received, Charged and Owed side by side ────────────────
// "NO Money received / Money billed toggle anywhere — show Charged, Received
// and Owed side by side as columns, with a short line showing how they tie."
// The S655 switch (and its remembered choice) is gone from every Books page;
// the API sends the three columns. Received leads (10/12, L2): the shared
// MONEY_COLUMNS order. An absent figure (a viewer the server leaves Owed out
// for) prints "—".
export type MoneyThreeFigures=Partial<Record<MoneyColumn,number|null|undefined>>
export interface MoneyThreeRow extends MoneyThreeFigures{ key:string; label:string }
const three=(n:number|null|undefined)=>n==null?'—':formatCurrency(Number(n))
export function MoneyThreeTable({rows,total,totalLabel='Total',empty}:{rows:MoneyThreeRow[];total?:MoneyThreeFigures;totalLabel?:string;empty?:string}){
  return(
    <div style={{overflowX:'auto'}}>
      <table className="tbl" style={{minWidth:360}}>
        <thead><tr><th></th>{MONEY_COLUMNS.map(k=><th key={k} style={{textAlign:'right'}}>{MONEY_COLUMN_LABEL[k]}</th>)}</tr></thead>
        <tbody>
          {rows.length?rows.map(r=>(
            <tr key={r.key}>
              <td style={{fontSize:'.78rem'}}>{r.label}</td>
              {MONEY_COLUMNS.map(k=><td key={k} className="mono" style={{textAlign:'right',color:k==='owed'&&Number(r[k])?'var(--amber)':Number(r[k])<0?'var(--red)':'var(--t1)'}}>{three(r[k])}</td>)}
            </tr>
          )):!total&&<tr><td colSpan={4} style={{color:'var(--t3)',fontSize:'.78rem'}}>{empty??'Nothing received or charged.'}</td></tr>}
          {total&&(
            <tr style={{borderTop:'2px solid var(--b1)'}}>
              <td style={{fontWeight:700,color:'var(--t0)'}}>{totalLabel}</td>
              {MONEY_COLUMNS.map(k=><td key={k} className="mono" style={{textAlign:'right',fontWeight:700,color:k==='received'?'var(--teal)':'var(--t0)'}}>{three(total[k])}</td>)}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
/** How the columns tie, in the server's own words. */
export function MoneyTieLines({lines}:{lines:string[]|null|undefined}){
  if(!lines?.length)return null
  return <div style={{fontSize:'.7rem',color:'var(--t3)',lineHeight:1.5,margin:'8px 0 4px'}}>{lines.map(l=><p key={l} style={{margin:'2px 0'}}>{l}</p>)}</div>
}

// ── LABELS ────────────────────────────────────────────────────────────
// 10/11: a contractor's W-9 tax classification (Contractors, Tax Center) and a
// pay frequency (Run Payroll, Pay History), in the API's own words
// (packages/shared booksLedger).
export const contractorClassLabel=(t:string)=>(BOOKS_CONTRACTOR_TAX_CLASSIFICATION_LABEL as Record<string,string>)[t]??humanize(t)
export const payFreqLabel=(f:string)=>(BOOKS_PAY_FREQUENCY_LABEL as Record<string,string>)[f]??humanize(f)

// ── STUB ──────────────────────────────────────────────────────────────
export function ComingSoon({title,icon,description}:{title:string;icon:string;description:string}){
  return(
    <div>
      <div className="ph"><div><h1 className="pt">{icon} {title}</h1><p className="ps">{description}</p></div></div>
      <div className="card" style={{textAlign:'center',padding:'60px 20px'}}>
        <div style={{fontSize:'3rem',marginBottom:16}}>{icon}</div>
        <h2 style={{color:'var(--t0)',marginBottom:8}}>{title}</h2>
        {/* 10/12 (Nic): plain "Coming soon" wording. */}
        <p style={{color:'var(--t3)',fontSize:'.85rem',maxWidth:420,margin:'0 auto'}}>Coming soon.</p>
      </div>
    </div>
  )
}
