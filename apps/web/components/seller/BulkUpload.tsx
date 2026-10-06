'use client';

import { ArrowUpTrayIcon, CheckBadgeIcon, ExclamationTriangleIcon } from '@heroicons/react/20/solid';
import Link from 'next/link';
import { useState } from 'react';

type Result = { ok: true; consignmentId: string; created: number; skippedExisting: number; repeatedBatch: boolean } | { ok: false; errors: Array<{ row: number; field: string; message: string }> } | { message: string };

const SAMPLE = `external_ref,title,description,category,item_state,condition,condition_notes,currency,starting_bid,reserve,estimate_low,estimate_high,quantity
ZIMRA-0001,Samsung 55in LED TV,Boxed television seized at Beitbridge; untested.,it,new,sealed_packing,,USD,120,,150,250,1
ZIMRA-0002,Office chairs (lot of 10),Mesh office chairs; two with worn armrests.,furniture,used,working,Two worn armrests,ZWG,2500,,,,10`;

export function BulkUpload() {
  const [csv, setCsv] = useState(SAMPLE);
  const [batch, setBatch] = useState(`BATCH-${new Date().toISOString().slice(0, 10)}`);
  const [branch, setBranch] = useState<'HRE' | 'BYO'>('HRE');
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  async function upload() {
    setBusy(true);
    const r = await fetch('/api/seller/bulk', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ csv, batchRef: batch, branch }) });
    setResult((await r.json()) as Result);
    setBusy(false);
  }
  return (
    <div className="stack">
      <div className="card"><div className="panel-body stack">
        <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="field" style={{ minWidth: 240 }}><label htmlFor="bu-batch">Batch reference</label><input id="bu-batch" className="input mono" value={batch} onChange={(e) => setBatch(e.target.value)} /></div>
          <div className="field"><span className="label">Branch</span>
            <div className="btn-group"><button type="button" className="btn ghost" aria-pressed={branch === 'HRE'} onClick={() => setBranch('HRE')}>Harare</button><button type="button" className="btn ghost" aria-pressed={branch === 'BYO'} onClick={() => setBranch('BYO')}>Bulawayo</button></div>
          </div>
          <label className="btn ghost" style={{ cursor: 'pointer' }}><ArrowUpTrayIcon /> Choose a CSV file<input type="file" accept=".csv,text/csv" hidden onChange={async (e) => { const file = e.target.files?.[0]; if (file) setCsv(await file.text()); }} /></label>
        </div>
        <div className="field"><label htmlFor="bu-csv">CSV</label><textarea id="bu-csv" className="input mono" style={{ height: 200, padding: 12, fontSize: 12 }} value={csv} onChange={(e) => setCsv(e.target.value)} /></div>
        <p className="small muted">Columns: external_ref, title, description, category, item_state, condition, condition_notes, currency (USD or ZWG per row), starting_bid, reserve, estimate_low, estimate_high, quantity. If any row has a problem, nothing is created and every problem is listed.</p>
        <div><button className="btn" onClick={upload} disabled={busy}><ArrowUpTrayIcon /> {busy ? 'Checking…' : 'Upload batch'}</button></div>
      </div></div>
      {result && 'ok' in result && result.ok && (
        <div className="notice good"><CheckBadgeIcon /><span>{result.repeatedBatch ? 'This batch was already uploaded; nothing new was created.' : `${result.created} lots created as drafts${result.skippedExisting ? `, ${result.skippedExisting} already existed` : ''}.`} <Link className="link" href={`/account/selling/consignments/${result.consignmentId}`}>Open the consignment</Link></span></div>
      )}
      {result && 'ok' in result && !result.ok && (
        <div className="nest">
          <div className="nest-head"><ExclamationTriangleIcon style={{ color: 'var(--bad)' }} /><h3>Nothing was created: fix these and upload again</h3><span className="badge urgent">{result.errors.length}</span></div>
          <div className="nest-body" style={{ padding: 0 }}>
            <table className="table"><thead><tr><th>Row</th><th>Column</th><th>Problem</th></tr></thead>
              <tbody>{result.errors.map((e, i) => <tr key={i}><td className="mono">{e.row}</td><td className="mono small">{e.field}</td><td>{e.message}</td></tr>)}</tbody></table>
          </div>
        </div>
      )}
      {result && 'message' in result && <div className="notice bad"><ExclamationTriangleIcon /><span>{result.message}</span></div>}
    </div>
  );
}
