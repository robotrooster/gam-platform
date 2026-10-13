/**
 * 10/12 (Nic): the tax center — payroll tax owed and the filing deadlines.
 *
 * GAM Books' own page, shown in GAM Books and inside the landlord portal's
 * Bookkeeping menu — the same bytes in apps/books and apps/landlord
 * (bookkeeping-parity.test.ts). How it reaches the API, shows a toast and
 * links to another Books page is the app's own (./adapter).
 */
import { useState } from 'react'
import { useQuery } from 'react-query'
import { formatCurrency, humanize, MONEY_COLUMN_LABEL } from '@gam/shared'
import { booksGet as get } from './adapter'
import { contractorClassLabel } from './common'

// ── TAX CENTER ────────────────────────────────────────────────────────
export function TaxCenterPage(){
  const now=new Date()
  const[year,setYear]=useState(now.getFullYear())
  const{data,isLoading}=useQuery(['tax',year],()=>get<any>(`/books/tax/summary?year=${year}`))

  const payroll=(data as any)?.payroll||{}
  const contractors=(data as any)?.contractors1099||[]
  const threshold1099=(data as any)?.contractors1099Threshold as number|null|undefined
  const employees=(data as any)?.employees||[]
  const deadlines=(data as any)?.filingDeadlines||[]

  return(
    <div>
      <div className="ph">
        <div><h1 className="pt">🏛 Tax Center</h1><p className="ps">Payroll tax liabilities and filing deadlines</p></div>
        <div style={{display:'flex',gap:8,alignItems:'center'}}>
          <label style={{marginBottom:0,textTransform:'none',letterSpacing:0,fontSize:'.82rem',color:'var(--t2)'}}>Tax Year</label>
          <select value={year} onChange={e=>setYear(+e.target.value)} style={{width:'auto',padding:'5px 10px',fontSize:'.82rem'}}>
            {[now.getFullYear(),now.getFullYear()-1,now.getFullYear()-2].map(y=><option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      <div className="grid4" style={{marginBottom:16}}>
        <div className="kpi"><div className="kl">YTD Gross Payroll</div><div className="kv gold">{formatCurrency(payroll.ytdGross||0)}</div><div className="ks">{payroll.runCount||0} approved runs</div></div>
        <div className="kpi"><div className="kl">Employee Tax W/H</div><div className="kv r">{formatCurrency((+payroll.ytdFederal||0)+(+payroll.ytdState||0)+(+payroll.ytdSs||0)+(+payroll.ytdMedicare||0))}</div><div className="ks">Fed + State + SS + Medicare</div></div>
        <div className="kpi"><div className="kl">Employer Taxes</div><div className="kv a">{formatCurrency((+payroll.employerSs||0)+(+payroll.employerMedicare||0)+(+payroll.futa||0)+(+payroll.suta||0))}</div><div className="ks">SS + Medicare match + unemployment</div></div>
        <div className="kpi"><div className="kl">Total Tax Liability</div><div className="kv r">{formatCurrency(payroll.totalTaxLiability||0)}</div><div className="ks">Employee + employer</div></div>
      </div>

      {/* 10/12 (Nic, ledger P8): once the company's books are live, the year's
          taxes as the books hold them — collected, paid to the government and
          still owed at the year's end — and the year's income and expenses,
          Received first (L2). GAM shows them; it does not file them. */}
      {(data as any)?.ledger&&<LedgerTaxCard ledger={(data as any).ledger} year={year}/>}

      {isLoading?<div style={{padding:32,color:'var(--t3)',textAlign:'center'}}><span className="spinner" style={{display:'inline-block'}}/></div>:(
        <div className="grid2" style={{gap:16,marginBottom:16}}>
          <div className="card">
            <div className="ct">Payroll Tax Breakdown ({year})</div>
            <div className="dr"><span className="dk">Federal Income W/H (employee)</span><span className="dv mono" style={{color:'var(--red)'}}>{formatCurrency(payroll.ytdFederal||0)}</span></div>
            <div className="dr"><span className="dk">Social Security (employee 6.2%)</span><span className="dv mono" style={{color:'var(--amber)'}}>{formatCurrency(payroll.ytdSs||0)}</span></div>
            <div className="dr"><span className="dk">Medicare (employee 1.45%)</span><span className="dv mono" style={{color:'var(--amber)'}}>{formatCurrency(payroll.ytdMedicare||0)}</span></div>
            <div className="dr"><span className="dk">State W/H (entered per paycheck)</span><span className="dv mono" style={{color:'var(--amber)'}}>{formatCurrency(payroll.ytdState||0)}</span></div>
            <div className="dr" style={{borderTop:'1px solid var(--b1)',paddingTop:6,marginTop:4}}><span className="dk">Employer SS match (6.2%)</span><span className="dv mono" style={{color:'var(--red)'}}>{formatCurrency(payroll.employerSs||0)}</span></div>
            <div className="dr"><span className="dk">Employer Medicare match (1.45%)</span><span className="dv mono" style={{color:'var(--red)'}}>{formatCurrency(payroll.employerMedicare||0)}</span></div>
            {/* 10/12 (Nic, ledger P7): the employer's unemployment taxes, entered on each run. */}
            <div className="dr"><span className="dk">Federal unemployment (employer)</span><span className="dv mono" style={{color:'var(--red)'}}>{formatCurrency(payroll.futa||0)}</span></div>
            <div className="dr"><span className="dk">State unemployment (employer)</span><span className="dv mono" style={{color:'var(--red)'}}>{formatCurrency(payroll.suta||0)}</span></div>
            <div className="dr" style={{borderTop:'2px solid var(--b1)',paddingTop:8,marginTop:8}}>
              <span style={{fontWeight:700,color:'var(--t0)',fontFamily:'var(--font-d)'}}>Total Liability</span>
              <span style={{fontFamily:'var(--font-m)',fontWeight:700,color:'var(--red)',fontSize:'1rem'}}>{formatCurrency(payroll.totalTaxLiability||0)}</span>
            </div>
          </div>

          <div className="card">
            <div className="ct">Filing Deadlines</div>
            {/* S203/S204: per-state catalog from services/taxForms.ts.
                 Shape: { state_code, form_code, form_name, agency,
                 agency_url, category, frequency, due_dates: [{label, due}],
                 statute, notes, filing_method }
                 S207: filing_method='online_portal' rows have no paper
                 form code; form_code is a descriptive label, link wording
                 says "Open portal" instead of "File online". */}
            {deadlines.map((d:any,idx:number)=>{
              const stateLabel = d.stateCode === 'US' ? 'Federal' : d.stateCode
              const dues = Array.isArray(d.dueDates) ? d.dueDates : []
              const isPortal = d.filingMethod === 'online_portal'
              return (
                <div key={d.stateCode+'-'+d.formCode+'-'+idx} style={{padding:'10px 0',borderBottom:'1px solid var(--b0)'}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:4,gap:8}}>
                    <div style={{display:'flex',alignItems:'baseline',gap:8,flexWrap:'wrap',flex:1,minWidth:0}}>
                      <span style={{fontFamily:'var(--font-m)',fontWeight:600,color:'var(--gold)',fontSize:'.82rem'}}>
                        {d.formCode}
                      </span>
                      <span className="badge bmu" style={{fontSize:'.62rem'}}>{stateLabel}</span>
                      <span className="badge bmu" style={{fontSize:'.62rem',textTransform:'capitalize'}}>{humanize(d.category)}</span>
                      {isPortal && (
                        <span className="badge ba" style={{fontSize:'.62rem'}}>Online portal</span>
                      )}
                    </div>
                  </div>
                  <div style={{fontSize:'.75rem',color:'var(--t2)',marginBottom:6}}>{d.formName}</div>
                  {dues.length > 0 && (
                    <div style={{display:'flex',gap:6,flexWrap:'wrap',marginBottom:6}}>
                      {dues.map((row:any,i:number)=>(
                        <span key={i} className="badge ba" style={{fontSize:'.62rem'}}>
                          {row.label}: {row.due}
                        </span>
                      ))}
                    </div>
                  )}
                  <div style={{fontSize:'.7rem',color:'var(--t3)',display:'flex',gap:6,flexWrap:'wrap',alignItems:'center'}}>
                    <span>{d.agency}</span>
                    {d.agencyUrl && (
                      <>
                        <span>·</span>
                        <a href={d.agencyUrl} target="_blank" rel="noopener noreferrer" style={{color:'var(--gold)',textDecoration:'none'}}>
                          {isPortal ? 'Open portal ↗' : 'File online ↗'}
                        </a>
                      </>
                    )}
                    {d.statute && (
                      <>
                        <span>·</span>
                        <span style={{fontStyle:'italic'}}>{d.statute}</span>
                      </>
                    )}
                  </div>
                  {d.notes && (
                    <div style={{fontSize:'.7rem',color:'var(--t3)',marginTop:4,fontStyle:'italic'}}>
                      {d.notes}
                    </div>
                  )}
                </div>
              )
            })}
            {deadlines.length === 0 && (
              <div style={{padding:'10px 0',fontSize:'.75rem',color:'var(--t3)'}}>
                No filing deadlines apply to your current setup. Add employees, contractors, or properties to surface relevant forms.
              </div>
            )}
          </div>
        </div>
      )}

      {/* 10/12 (Nic): "contractors get a 1099 box and their payments add up per
          calendar year" — every vendor with the 1099 box paid in the year, what
          a 1099-NEC counts (card payments are reported by the card company and
          left out), and that year's threshold. */}
      {(contractors as any[]).length>0&&(
        <div className="card" style={{marginBottom:16}}>
          <div className="ct">1099-NEC ({year}) — contractors with the 1099 box</div>
          <p style={{fontSize:'.74rem',color:'var(--t3)',marginTop:0}}>A 1099-NEC is due for each one paid {formatCurrency(threshold1099??0)} or more in {year}. Payments made by card are reported by the card company, so they are left out of that figure.</p>
          {(contractors as any[]).filter((c:any)=>c.needs1099&&!c.w9OnFile).length>0&&(
            <div className="alert aw" style={{marginBottom:12}}>⚠ {(contractors as any[]).filter((c:any)=>c.needs1099&&!c.w9OnFile).length} contractor(s) who need a 1099 have no W-9 on file. Collect it before January 31.</div>
          )}
          <div style={{overflowX:'auto'}}>
            <table className="tbl" style={{minWidth:600}}>
              <thead><tr><th>Contractor</th><th>W-9 box</th><th>Taxpayer ID</th><th>Paid in {year}</th><th>By card</th><th>Counts for 1099</th><th>W-9</th><th>1099</th></tr></thead>
              <tbody>
                {(contractors as any[]).map((c:any)=>(
                  <tr key={c.vendorId}>
                    <td style={{fontWeight:600,color:'var(--t0)'}}>{c.name}{c.status!=='active'&&<span className="badge bmu" style={{marginLeft:6}}>Inactive</span>}</td>
                    <td><span className="badge bmu">{c.taxClassification?contractorClassLabel(c.taxClassification):'Not known'}</span></td>
                    <td className="mono" style={{fontSize:'.72rem'}}>{c.taxIdLast4?`••${c.taxIdLast4}`:<span className="badge br">Missing</span>}</td>
                    <td className="mono">{formatCurrency(c.paid)}</td>
                    <td className="mono" style={{color:'var(--t3)'}}>{+c.paidByCard>0?formatCurrency(c.paidByCard):'—'}</td>
                    <td className="mono" style={{color:'var(--amber)',fontWeight:600}}>{formatCurrency(c.reportable)}</td>
                    <td>{c.w9OnFile?<span className="badge bg2">✓ On File</span>:<span className="badge br">Missing</span>}</td>
                    <td>{c.needs1099?<span className={c.w9OnFile&&c.taxIdLast4?'badge bg2':'badge ba'}>{c.w9OnFile&&c.taxIdLast4?'Ready to file':'Needs a W-9'}</span>:<span className="badge bmu">Under {formatCurrency(threshold1099??0)}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {employees.length>0&&(
        <div className="card">
          <div className="ct">W-2 Employee YTD Summary ({year})</div>
          <table className="tbl">
            <thead><tr><th>Employee</th><th>YTD Gross</th><th>Federal W/H</th><th>State</th><th>SS</th><th>Medicare</th><th>Net Pay</th></tr></thead>
            <tbody>
              {employees.map((e:any,i:number)=>(
                <tr key={i}>
                  <td style={{fontWeight:600,color:'var(--t0)'}}>{e.firstName} {e.lastName}</td>
                  <td className="mono" style={{color:'var(--gold)'}}>{formatCurrency(e.ytdGross)}</td>
                  <td className="mono" style={{color:'var(--red)'}}>{formatCurrency(e.ytdFederalTax)}</td>
                  <td className="mono" style={{color:'var(--amber)'}}>{formatCurrency(e.ytdStateTax)}</td>
                  <td className="mono" style={{color:'var(--amber)'}}>{formatCurrency(e.ytdSs)}</td>
                  <td className="mono" style={{color:'var(--amber)'}}>{formatCurrency(e.ytdMedicare)}</td>
                  <td className="mono" style={{color:'var(--green)',fontWeight:700}}>{formatCurrency(e.ytdNet)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/** 10/12 (Nic, ledger P8): the year on the books — taxes by account, income and expenses both ways. */
function LedgerTaxCard({ledger,year}:{ledger:any;year:number}){
  const rows:any[]=ledger?.taxes?.rows??[]
  const t=ledger?.taxes?.totals
  return(
    <div className="card" style={{marginBottom:16}}>
      <div className="ct">On your books ({year})</div>
      <div className="grid2" style={{gap:16}}>
        <div>
          <div className="dr"><span className="dk">Income {MONEY_COLUMN_LABEL.received.toLowerCase()}</span><span className="dv mono" style={{color:'var(--green)'}}>{formatCurrency(ledger?.income?.received??0)}</span></div>
          <div className="dr"><span className="dk">Income {MONEY_COLUMN_LABEL.charged.toLowerCase()}</span><span className="dv mono">{formatCurrency(ledger?.income?.charged??0)}</span></div>
          <div className="dr"><span className="dk">Expenses paid</span><span className="dv mono" style={{color:'var(--red)'}}>{formatCurrency(ledger?.expenses?.paid??0)}</span></div>
          <div className="dr"><span className="dk">Expenses incurred</span><span className="dv mono">{formatCurrency(ledger?.expenses?.incurred??0)}</span></div>
          <div className="dr" style={{borderTop:'1px solid var(--b1)',paddingTop:6,marginTop:4}}><span className="dk" style={{fontWeight:700}}>Net · {MONEY_COLUMN_LABEL.received.toLowerCase()}</span><span className="dv mono" style={{fontWeight:700}}>{formatCurrency(ledger?.nets?.received??0)}</span></div>
          <div className="dr"><span className="dk">Net · {MONEY_COLUMN_LABEL.charged.toLowerCase()}</span><span className="dv mono">{formatCurrency(ledger?.nets?.charged??0)}</span></div>
        </div>
        <div style={{overflowX:'auto'}}>
          <table className="tbl" style={{minWidth:340}}>
            <thead><tr><th>Tax</th><th style={{textAlign:'right'}}>Collected</th><th style={{textAlign:'right'}}>Paid</th><th style={{textAlign:'right'}}>Owed at year end</th></tr></thead>
            <tbody>
              {rows.map(r=>(
                <tr key={`${r.accountId}|${r.taxName??''}`}>
                  <td style={{fontSize:'.78rem'}}>{r.code} · {r.name}{r.taxName?` (${r.taxName})`:''}</td>
                  <td className="mono" style={{textAlign:'right'}}>{formatCurrency(r.collected)}</td>
                  <td className="mono" style={{textAlign:'right'}}>{formatCurrency(r.paid)}</td>
                  <td className="mono" style={{textAlign:'right',color:Number(r.owedAtEnd)?'var(--amber)':'var(--t1)'}}>{formatCurrency(r.owedAtEnd)}</td>
                </tr>
              ))}
              {rows.length===0&&<tr><td colSpan={4} style={{color:'var(--t3)',fontSize:'.78rem'}}>No tax collected or owed on your books this year.</td></tr>}
              {t&&rows.length>0&&<tr style={{borderTop:'2px solid var(--b1)'}}><td style={{fontWeight:700}}>Total</td><td className="mono" style={{textAlign:'right',fontWeight:700}}>{formatCurrency(t.collected)}</td><td className="mono" style={{textAlign:'right',fontWeight:700}}>{formatCurrency(t.paid)}</td><td className="mono" style={{textAlign:'right',fontWeight:700}}>{formatCurrency(t.owedAtEnd)}</td></tr>}
            </tbody>
          </table>
          <div className="bnote">GAM shows the taxes your books hold; it does not file them.</div>
        </div>
      </div>
    </div>
  )
}
