/**
 * 10/12 (Nic): the payroll runs, and voiding an approved one.
 *
 * GAM Books' own page, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts). How it reaches the API, shows a toast and
 * links to another Books page is the app's own (./adapter).
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from 'react-query'
import { formatCurrency, humanize } from '@gam/shared'
import { booksGet as get, booksPost as post, toast, appConfirm, booksPath } from './adapter'
import { payFreqLabel } from './common'

// ── PAY HISTORY ───────────────────────────────────────────────────────
export function PayHistoryPage(){
  const{data:runs=[],isLoading}=useQuery('payroll-runs',()=>get<any[]>('/books/payroll/runs'))
  const[selected,setSelected]=useState<any>(null)
  const{data:runDetail}=useQuery(['payroll-run',selected?.id],()=>get<any>(`/books/payroll/runs/${selected.id}`),{enabled:!!selected?.id})
  const qc=useQueryClient()

  const voidRun=async(id:string)=>{
    // 10/12 (Nic, ledger P7): voiding takes the run back out of the books, voids
    // the unpaid take-home pay and tax bills it left on Expenses, and puts any
    // work-trade hours it paid back to waiting. Refused while any of it is paid.
    if(!(await appConfirm('Void this approved run? Year-to-date figures are reversed, it is taken back out of your books, and the unpaid take-home pay and tax bills it left on Expenses are voided. A run with any of those already paid cannot be voided until that payment is undone.', { danger: true, confirmLabel: 'Void' })))return
    try{
      await post(`/books/payroll/runs/${id}/void`)
      qc.invalidateQueries('payroll-runs')
      qc.invalidateQueries('emp')
      qc.invalidateQueries('work-trade-pay')
      setSelected(null)
    }catch(ex:any){toast.error(ex.response?.data?.error||'Could not void this run.')}
  }

  const STATUS:Record<string,string>={draft:'ba',approved:'bg2',voided:'bmu'}

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">🕐 Pay History</h1><p className="ps">{(runs as any[]).length} payroll runs</p></div>
        <Link to={booksPath('runPayroll')} className="btn bp">▶ New Run</Link>
      </div>

      <div className="grid2" style={{gap:16}}>
        <div className="card" style={{padding:0,overflowX:'auto'}}>
          {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
            <table className="tbl">
              <thead><tr><th>Pay Date</th><th>Period</th><th>Freq</th><th>Employees</th><th>Gross</th><th>Net</th><th>Status</th></tr></thead>
              <tbody>
                {(runs as any[]).length?(runs as any[]).map((r:any)=>(
                  <tr key={r.id} style={{cursor:'pointer',background:selected?.id===r.id?'rgba(201,162,39,.05)':''}} onClick={()=>setSelected(r)}>
                    <td className="mono" style={{color:'var(--t0)',fontWeight:600}}>{new Date(r.payDate+'T12:00:00').toLocaleDateString()}</td>
                    <td style={{fontSize:'.68rem',color:'var(--t3)'}}>{new Date(r.periodStart+'T12:00:00').toLocaleDateString()} – {new Date(r.periodEnd+'T12:00:00').toLocaleDateString()}</td>
                    <td><span className="badge bmu" style={{fontSize:'.6rem'}}>{payFreqLabel(r.payFrequency)}</span></td>
                    <td className="mono">{r.employeeCount}</td>
                    <td className="mono" style={{color:'var(--gold)'}}>{formatCurrency(r.totalGross)}</td>
                    <td className="mono" style={{color:'var(--green)'}}>{formatCurrency(r.totalNet)}</td>
                    <td><span className={`badge ${STATUS[r.status]||'bmu'}`}>{humanize(r.status)}</span></td>
                  </tr>
                )):<tr><td colSpan={7}><div className="empty">No payroll runs yet.</div></td></tr>}
              </tbody>
            </table>
          )}
        </div>

        <div>
          {!selected&&<div className="card" style={{textAlign:'center',padding:'48px 20px',color:'var(--t3)'}}>Select a run to view details</div>}
          {selected&&runDetail&&(
            <div className="card">
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
                <div>
                  <div style={{fontFamily:'var(--font-d)',fontWeight:700,color:'var(--t0)'}}>Pay Date: {new Date(runDetail.payDate+'T12:00:00').toLocaleDateString()}</div>
                  <div style={{fontSize:'.72rem',color:'var(--t3)',marginTop:2}}>{new Date(runDetail.periodStart+'T12:00:00').toLocaleDateString()} – {new Date(runDetail.periodEnd+'T12:00:00').toLocaleDateString()} · {payFreqLabel(runDetail.payFrequency)}</div>
                </div>
                <span className={`badge ${STATUS[runDetail.status]||'bmu'}`}>{humanize(runDetail.status)}</span>
              </div>
              <div className="dr"><span className="dk">Gross Pay</span><span className="dv mono" style={{color:'var(--gold)'}}>{formatCurrency(runDetail.totalGross)}</span></div>
              <div className="dr"><span className="dk">Federal W/H</span><span className="dv mono" style={{color:'var(--red)'}}>{formatCurrency(runDetail.totalFederalTax)}</span></div>
              <div className="dr"><span className="dk">SS + Medicare</span><span className="dv mono" style={{color:'var(--amber)'}}>{formatCurrency((+runDetail.totalSs)+(+runDetail.totalMedicare))}</span></div>
              <div className="dr"><span className="dk">State Tax</span><span className="dv mono" style={{color:'var(--amber)'}}>{formatCurrency(runDetail.totalStateTax)}</span></div>
              <div className="dr" style={{borderTop:'1px solid var(--b1)',paddingTop:8,marginTop:4}}><span className="dk" style={{fontWeight:700}}>Net Pay</span><span className="dv mono" style={{color:'var(--green)',fontWeight:700}}>{formatCurrency(runDetail.totalNet)}</span></div>
              {/* 10/12 (Nic, ledger P7): the employer's own taxes, recorded on the run. */}
              <div className="dr" style={{marginTop:8}}><span className="dk">Employer SS + Medicare</span><span className="dv mono" style={{color:'var(--amber)'}}>{formatCurrency((+runDetail.totalEmployerSs||0)+(+runDetail.totalEmployerMedicare||0))}</span></div>
              <div className="dr"><span className="dk">Federal + state unemployment</span><span className="dv mono" style={{color:'var(--amber)'}}>{formatCurrency((+runDetail.totalFuta||0)+(+runDetail.totalSuta||0))}</span></div>

              <div style={{marginTop:16}}>
                <div className="ct">Employee Lines</div>
                {runDetail.lines?.map((l:any)=>(
                  <div key={l.id} style={{padding:'8px 0',borderBottom:'1px solid var(--b0)',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                    <div>
                      <div style={{fontSize:'.82rem',fontWeight:600,color:'var(--t0)'}}>{l.firstName} {l.lastName}</div>
                      <div style={{fontSize:'.68rem',color:'var(--t3)'}}>{l.memo?`${l.memo} · `:''}Gross {formatCurrency(l.grossPay)} · Net {formatCurrency(l.netPay)}</div>
                    </div>
                    <span className="mono" style={{color:'var(--green)',fontWeight:600}}>{formatCurrency(l.netPay)}</span>
                  </div>
                ))}
              </div>

              {runDetail.status==='approved'&&(
                <div style={{marginTop:16}}>
                  <button className="btn bd bsm" onClick={()=>voidRun(runDetail.id)}>Void This Run</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
