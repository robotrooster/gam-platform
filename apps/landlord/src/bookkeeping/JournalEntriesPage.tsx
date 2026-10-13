/**
 * 10/12 (Nic): journal entries — the company ledger's double-entry postings.
 *
 * GAM Books' own page, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts). How it reaches the API, shows a toast and
 * links to another Books page is the app's own (./adapter).
 *
 * 10/12 (Nic, ledger P7): "every money event posts its own balanced lines
 * automatically; the bookkeeper adds adjusting entries on top." Each line may
 * name the property it belongs to (none = the whole company); an entry is an
 * ordinary one or an adjusting one; Reverse takes an entry back on a later day
 * (an accrual reversed on the first of the next month). Accounts GAM keeps
 * from the money records, and months that are closed, are refused by the
 * server in words.
 */
import React, { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from 'react-query'
import {
  formatCurrency, humanize, BOOKS_JOURNAL_ENTRY_TYPE_LABEL, BOOKS_JOURNAL_ENTRY_TYPES_TYPED,
  type BooksJournalEntryType,
} from '@gam/shared'
import { booksGet as get, booksPost as post, toast, appConfirm, booksPath } from './adapter'
import { Modal } from './common'
import { localToday } from './booksMoney'

type FormLine={accountId:string;description:string;debit:string;credit:string;propertyId:string}
const blankLine=():FormLine=>({accountId:'',description:'',debit:'',credit:'',propertyId:''})
const kindLabel=(t:string)=>(BOOKS_JOURNAL_ENTRY_TYPE_LABEL as Record<string,string>)[t]??humanize(t)
const day=(d:string)=>new Date(String(d).slice(0,10)+'T12:00:00').toLocaleDateString()

// ── JOURNAL ENTRIES ───────────────────────────────────────────────────
export function JournalEntriesPage(){
  const qc=useQueryClient()
  const{data:entries=[],isLoading}=useQuery('journal',()=>get<any[]>('/books/journal'))
  const{data:accounts=[]}=useQuery('acct',()=>get<any[]>('/books/accounts'))
  // The company's properties, for each line's property (none = the whole company).
  const{data:properties=[]}=useQuery('books-properties',()=>get<any[]>('/books/properties'),{retry:false})
  const[showAdd,setShowAdd]=useState(false)
  const[selectedEntry,setSelectedEntry]=useState<any>(null)
  const{data:entryDetail}=useQuery(['je',selectedEntry?.id],()=>get<any>('/books/journal/'+selectedEntry.id),{enabled:!!selectedEntry?.id})
  const[err,setErr]=useState('')
  const[saving,setSaving]=useState(false)
  const initForm={date:localToday(),description:'',reference:'',type:'manual' as BooksJournalEntryType,lines:[blankLine(),blankLine()]}
  const[form,setForm]=useState(initForm)
  // Reverse: the entry being taken back and the day the reversal is dated.
  const[reversing,setReversing]=useState<any>(null)
  const[reverseDate,setReverseDate]=useState('')
  const[reverseErr,setReverseErr]=useState('')

  const totalDebits=form.lines.reduce((s,l)=>s+(+l.debit||0),0)
  const totalCredits=form.lines.reduce((s,l)=>s+(+l.credit||0),0)
  const balanced=Math.round(totalDebits*100)===Math.round(totalCredits*100)&&totalDebits>0

  const addLine=()=>setForm(f=>({...f,lines:[...f.lines,blankLine()]}))
  const removeLine=(i:number)=>setForm(f=>({...f,lines:f.lines.filter((_,idx)=>idx!==i)}))
  const updateLine=(i:number,k:keyof FormLine,v:string)=>setForm(f=>({...f,lines:f.lines.map((l,idx)=>idx===i?{...l,[k]:v}:l)}))

  const refresh=()=>{qc.invalidateQueries('journal');qc.invalidateQueries('acct');qc.invalidateQueries('je')}

  const submit=async(e:React.FormEvent)=>{
    e.preventDefault();setSaving(true);setErr('')
    try{
      await post('/books/journal',{
        date:form.date,description:form.description,reference:form.reference,type:form.type,
        lines:form.lines.filter(l=>l.accountId).map(l=>({
          accountId:l.accountId,description:l.description,debit:+l.debit||0,credit:+l.credit||0,propertyId:l.propertyId||null,
        })),
      })
      refresh()
      setShowAdd(false);setForm(initForm)
    }catch(ex:any){setErr(ex.response?.data?.error||'Could not post this entry.')}
    finally{setSaving(false)}
  }

  const voidEntry=async(id:string)=>{
    if(!(await appConfirm('Void this journal entry? It stays on the books marked voided, and what it moved is taken back.', { danger: true, confirmLabel: 'Void' })))return
    try{
      await post('/books/journal/'+id+'/void')
      refresh()
      setSelectedEntry(null)
    }catch(ex:any){toast.error(ex.response?.data?.error||'Could not void this entry.')}
  }

  const openReverse=(entry:any)=>{setReversing(entry);setReverseDate(localToday()>String(entry.date).slice(0,10)?localToday():String(entry.date).slice(0,10));setReverseErr('')}
  const submitReverse=async(e:React.FormEvent)=>{
    e.preventDefault();setReverseErr('')
    try{
      const r=await post<any>('/books/journal/'+reversing.id+'/reverse',{date:reverseDate})
      refresh()
      setReversing(null)
      setSelectedEntry({id:r.data.id})
      toast(`Entry #${r.data.entryNumber} reverses entry #${reversing.entryNumber}.`)
    }catch(ex:any){setReverseErr(ex.response?.data?.error||'Could not reverse this entry.')}
  }

  const STATUS:Record<string,string>={posted:'bg2',voided:'bmu',draft:'ba'}
  const byType=(t:string)=>(accounts as any[]).filter((a:any)=>a.type===t)
  const groups:[string,any[]][]=[['Assets',byType('asset')],['Liabilities',byType('liability')],['Equity',byType('equity')],['Income',byType('income')],['Expenses',byType('expense')]]
  const props=properties as any[]
  const isLive=(e:any)=>e&&e.status==='posted'&&!e.voidedAt

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">📓 Journal Entries</h1><p className="ps">{(entries as any[]).length} entries · adjustments on top of what GAM books by itself</p></div>
        <button className="btn bp" onClick={()=>setShowAdd(true)}>+ New Entry</button>
      </div>

      {(accounts as any[]).length===0&&<div className="alert aw">⚠ No chart of accounts found. <Link to={booksPath('accounts')}>Set up your accounts</Link> before creating journal entries.</div>}

      <div className="grid2" style={{gap:16}}>
        <div className="card" style={{padding:0,overflowX:'auto'}}>
          {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
            <table className="tbl">
              <thead><tr><th>#</th><th>Date</th><th>Description</th><th>Debits</th><th>Status</th></tr></thead>
              <tbody>
                {(entries as any[]).length?(entries as any[]).map((e:any)=>(
                  <tr key={e.id} style={{cursor:'pointer',background:selectedEntry?.id===e.id?'rgba(201,162,39,.05)':''}} onClick={()=>setSelectedEntry(e)}>
                    <td className="mono" style={{color:'var(--t3)',fontSize:'.7rem'}}>{e.entryNumber}</td>
                    <td className="mono" style={{fontSize:'.75rem'}}>{day(e.date)}</td>
                    <td style={{color:'var(--t0)',fontSize:'.78rem'}}>
                      {e.description}
                      {e.type!=='manual'&&<div style={{fontSize:'.65rem',color:'var(--t3)'}}>{kindLabel(e.type)}{e.reversesEntryNumber!=null?` of #${e.reversesEntryNumber}`:''}</div>}
                    </td>
                    <td className="mono">{formatCurrency(e.totalDebits)}</td>
                    <td><span className={`badge ${STATUS[e.status]||'bmu'}`}>{humanize(e.status)}</span>{e.reversedByEntryId&&<div style={{fontSize:'.62rem',color:'var(--t3)'}}>Reversed</div>}</td>
                  </tr>
                )):<tr><td colSpan={5}><div className="empty">No journal entries yet.</div></td></tr>}
              </tbody>
            </table>
          )}
        </div>

        <div>
          {!selectedEntry&&<div className="card" style={{textAlign:'center',padding:'48px 20px',color:'var(--t3)'}}>Select an entry to view detail</div>}
          {selectedEntry&&entryDetail&&(
            <div className="card">
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',gap:12,marginBottom:16}}>
                <div style={{minWidth:0}}>
                  <div style={{fontFamily:'var(--font-d)',fontWeight:700,color:'var(--t0)',marginBottom:4}}>Entry #{entryDetail.entryNumber}</div>
                  <div style={{fontSize:'.72rem',color:'var(--t3)'}}>{day(entryDetail.date)} · {kindLabel(entryDetail.type)}</div>
                  <div style={{fontSize:'.82rem',color:'var(--t1)',marginTop:4}}>{entryDetail.description}</div>
                  {entryDetail.reference&&<div style={{fontSize:'.7rem',color:'var(--t3)',marginTop:2}}>Ref: {entryDetail.reference}</div>}
                  {entryDetail.reversesEntryNumber!=null&&<div style={{fontSize:'.7rem',color:'var(--t3)',marginTop:2}}>Takes back entry #{entryDetail.reversesEntryNumber}</div>}
                  {entryDetail.reversedByEntryNumber!=null&&<div style={{fontSize:'.7rem',color:'var(--t3)',marginTop:2}}>Taken back by entry #{entryDetail.reversedByEntryNumber}</div>}
                  {entryDetail.adjustsRecordLabel&&<div style={{fontSize:'.7rem',color:'var(--t3)',marginTop:2}}>Adjusts: {entryDetail.adjustsRecordLabel}</div>}
                  {entryDetail.voidedAt&&<div style={{fontSize:'.7rem',color:'var(--t3)',marginTop:2}}>Voided {day(entryDetail.voidedAt)}</div>}
                </div>
                <span className={`badge ${STATUS[entryDetail.status]||'bmu'}`}>{humanize(entryDetail.status)}</span>
              </div>
              <div style={{overflowX:'auto'}}>
                <table className="tbl" style={{marginBottom:12,minWidth:420}}>
                  <thead><tr><th>Account</th><th>Property</th><th style={{textAlign:'right'}}>Debit</th><th style={{textAlign:'right'}}>Credit</th></tr></thead>
                  <tbody>
                    {entryDetail.lines?.map((l:any)=>(
                      <tr key={l.id}>
                        <td>
                          <div style={{fontWeight:600,color:'var(--t0)',fontSize:'.75rem'}}>{l.code} · {l.accountName}</div>
                          {l.description&&<div style={{fontSize:'.68rem',color:'var(--t3)'}}>{l.description}</div>}
                        </td>
                        <td style={{fontSize:'.72rem',color:'var(--t3)'}}>{l.propertyName?`${l.propertyName}${l.unitNumber?` · ${l.unitNumber}`:''}`:'Whole company'}</td>
                        <td className="mono" style={{textAlign:'right',color:+l.debit>0?'var(--t0)':'var(--t3)'}}>{+l.debit>0?formatCurrency(l.debit):'—'}</td>
                        <td className="mono" style={{textAlign:'right',color:+l.credit>0?'var(--t0)':'var(--t3)'}}>{+l.credit>0?formatCurrency(l.credit):'—'}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{background:'var(--bg3)'}}>
                      <td colSpan={2} style={{padding:'8px 12px',fontWeight:700,color:'var(--t0)',fontSize:'.72rem'}}>TOTALS</td>
                      <td className="mono" style={{textAlign:'right',fontWeight:700,padding:'8px 12px'}}>{formatCurrency(entryDetail.totalDebits)}</td>
                      <td className="mono" style={{textAlign:'right',fontWeight:700,padding:'8px 12px'}}>{formatCurrency(entryDetail.totalCredits)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              {isLive(entryDetail)&&(
                <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                  {entryDetail.type!=='reversing'&&!entryDetail.reversedByEntryId&&<button className="btn bp bsm" onClick={()=>openReverse(entryDetail)}>Reverse…</button>}
                  <button className="btn bd bsm" onClick={()=>voidEntry(entryDetail.id)}>Void Entry</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {showAdd&&(
        <Modal title="New Journal Entry" onClose={()=>setShowAdd(false)}>
          {err&&<div className="alert ae">{err}</div>}
          <form onSubmit={submit}>
            <div className="frow2">
              <div><label>Date</label><input type="date" value={form.date} onChange={e=>setForm(f=>({...f,date:e.target.value}))} required/></div>
              <div><label>Kind of entry</label>
                <select value={form.type} onChange={e=>setForm(f=>({...f,type:e.target.value as BooksJournalEntryType}))}>
                  {BOOKS_JOURNAL_ENTRY_TYPES_TYPED.map(t=><option key={t} value={t}>{kindLabel(t)}</option>)}
                </select>
              </div>
            </div>
            <div className="frow"><label>Description</label><input type="text" value={form.description} onChange={e=>setForm(f=>({...f,description:e.target.value}))} required placeholder="e.g. Accrue the March plumber's bill"/></div>
            <div className="frow"><label>Reference (optional)</label><input type="text" value={form.reference} onChange={e=>setForm(f=>({...f,reference:e.target.value}))} placeholder="Invoice #, check #…"/></div>

            <div style={{marginBottom:10}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
                <label style={{marginBottom:0}}>Lines</label>
                <button type="button" className="btn bp bsm" onClick={addLine}>+ Add Line</button>
              </div>
              <div style={{overflowX:'auto'}}>
                <table style={{width:'100%',minWidth:560,borderCollapse:'collapse',fontSize:'.75rem'}}>
                  <thead><tr>
                    <th style={{textAlign:'left',padding:'4px 6px',color:'var(--t3)',fontWeight:600,fontSize:'.65rem',textTransform:'uppercase'}}>Account</th>
                    <th style={{textAlign:'left',padding:'4px 6px',color:'var(--t3)',fontWeight:600,fontSize:'.65rem',textTransform:'uppercase'}}>Property</th>
                    <th style={{textAlign:'left',padding:'4px 6px',color:'var(--t3)',fontWeight:600,fontSize:'.65rem',textTransform:'uppercase'}}>Note</th>
                    <th style={{textAlign:'right',padding:'4px 6px',color:'var(--t3)',fontWeight:600,fontSize:'.65rem',textTransform:'uppercase'}}>Debit</th>
                    <th style={{textAlign:'right',padding:'4px 6px',color:'var(--t3)',fontWeight:600,fontSize:'.65rem',textTransform:'uppercase'}}>Credit</th>
                    <th></th>
                  </tr></thead>
                  <tbody>
                    {form.lines.map((line,i)=>(
                      <tr key={i}>
                        <td style={{padding:'3px 4px'}}>
                          <select value={line.accountId} onChange={e=>updateLine(i,'accountId',e.target.value)} style={{width:'100%',fontSize:'.72rem',padding:'5px 6px'}}>
                            <option value="">Select…</option>
                            {groups.map(([label,grp])=>grp.length>0&&<optgroup key={label} label={label}>{grp.map((a:any)=><option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</optgroup>)}
                          </select>
                        </td>
                        <td style={{padding:'3px 4px'}}>
                          <select value={line.propertyId} onChange={e=>updateLine(i,'propertyId',e.target.value)} style={{width:'100%',fontSize:'.72rem',padding:'5px 6px'}}>
                            <option value="">Whole company</option>
                            {props.map((p:any)=><option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        </td>
                        <td style={{padding:'3px 4px'}}><input type="text" value={line.description} onChange={e=>updateLine(i,'description',e.target.value)} placeholder="optional" style={{fontSize:'.72rem',padding:'5px 6px'}}/></td>
                        <td style={{padding:'3px 4px'}}><input type="number" min="0" step="0.01" value={line.debit} onChange={e=>updateLine(i,'debit',e.target.value)} style={{textAlign:'right',fontSize:'.72rem',padding:'5px 6px',width:90}}/></td>
                        <td style={{padding:'3px 4px'}}><input type="number" min="0" step="0.01" value={line.credit} onChange={e=>updateLine(i,'credit',e.target.value)} style={{textAlign:'right',fontSize:'.72rem',padding:'5px 6px',width:90}}/></td>
                        <td style={{padding:'3px 4px'}}>{form.lines.length>2&&<button type="button" aria-label="Remove line" onClick={()=>removeLine(i)} style={{background:'none',border:'none',color:'var(--red)',cursor:'pointer',fontSize:'.9rem'}}>✕</button>}</td>
                      </tr>
                    ))}
                    <tr style={{background:'var(--bg3)'}}>
                      <td colSpan={3} style={{padding:'6px 8px',fontSize:'.72rem',color:'var(--t3)',fontWeight:600}}>TOTALS</td>
                      <td style={{padding:'6px 8px',textAlign:'right',fontFamily:'var(--font-m)',fontSize:'.78rem',color:balanced?'var(--green)':'var(--amber)'}}>{formatCurrency(totalDebits)}</td>
                      <td style={{padding:'6px 8px',textAlign:'right',fontFamily:'var(--font-m)',fontSize:'.78rem',color:balanced?'var(--green)':'var(--amber)'}}>{formatCurrency(totalCredits)}</td>
                      <td/>
                    </tr>
                  </tbody>
                </table>
              </div>
              {!balanced&&totalDebits>0&&<div style={{fontSize:'.72rem',color:'var(--amber)',marginTop:6}}>⚠ Entry out of balance by {formatCurrency(Math.abs(totalDebits-totalCredits))}</div>}
              {balanced&&<div style={{fontSize:'.72rem',color:'var(--green)',marginTop:6}}>✓ Entry is balanced</div>}
              <div style={{fontSize:'.68rem',color:'var(--t3)',marginTop:6}}>A line with no property counts for the whole company. Accounts GAM keeps from your money records (tenant balances, money GAM holds, deposits, bills owed) take no journal lines.</div>
            </div>

            <div className="factions">
              <button type="button" className="btn bg-btn" onClick={()=>setShowAdd(false)}>Cancel</button>
              <button type="submit" className="btn bp" disabled={saving||!balanced}>{saving?<><span className="spinner"/>Posting…</>:'Post Entry'}</button>
            </div>
          </form>
        </Modal>
      )}

      {reversing&&(
        <Modal title={`Reverse entry #${reversing.entryNumber}`} onClose={()=>setReversing(null)}>
          {reverseErr&&<div className="alert ae">{reverseErr}</div>}
          <form onSubmit={submitReverse}>
            <p style={{fontSize:'.8rem',color:'var(--t2)',marginTop:0}}>A new entry with every line's side swapped, dated the day you pick (on or after {day(reversing.date)}). Entry #{reversing.entryNumber} stays on the books; together they come to zero from that day.</p>
            <div className="frow"><label>Date of the reversal</label><input type="date" value={reverseDate} min={String(reversing.date).slice(0,10)} onChange={e=>setReverseDate(e.target.value)} required/></div>
            <div className="factions">
              <button type="button" className="btn bg-btn" onClick={()=>setReversing(null)}>Cancel</button>
              <button type="submit" className="btn bp" disabled={!reverseDate}>Reverse Entry</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
