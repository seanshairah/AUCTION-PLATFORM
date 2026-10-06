'use client';

import { ChevronRightIcon } from '@heroicons/react/20/solid';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function NewConsignment() {
  const router = useRouter();
  const [branch, setBranch] = useState<'HRE' | 'BYO'>('HRE');
  const [type, setType] = useState<'commission' | 'outright_purchase'>('commission');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function create() {
    setBusy(true);
    const r = await fetch('/api/seller/consignments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ branch, type }) });
    const j = (await r.json()) as { id?: string; message?: string };
    if (j.id) router.push(`/account/selling/consignments/${j.id}`);
    else { setError(j.message ?? 'Could not start the consignment.'); setBusy(false); }
  }
  return (
    <div className="card" style={{ maxWidth: 560 }}>
      <div className="panel-body stack">
        <div className="field">
          <span className="label">Branch</span>
          <div className="btn-group">
            <button type="button" className="btn ghost" aria-pressed={branch === 'HRE'} onClick={() => setBranch('HRE')}>Harare</button>
            <button type="button" className="btn ghost" aria-pressed={branch === 'BYO'} onClick={() => setBranch('BYO')}>Bulawayo</button>
          </div>
        </div>
        <div className="field">
          <span className="label">How you sell</span>
          <div className="btn-group">
            <button type="button" className="btn ghost" aria-pressed={type === 'commission'} onClick={() => setType('commission')}>Commission sale</button>
            <button type="button" className="btn ghost" aria-pressed={type === 'outright_purchase'} onClick={() => setType('outright_purchase')}>Sell to ABC outright</button>
          </div>
          <p className="small muted">A commission sale goes to auction and you receive the hammer price less the published commission.</p>
        </div>
        {error && <div className="notice bad">{error}</div>}
        <button className="btn lg" onClick={create} disabled={busy}>{busy ? 'Starting…' : 'Start consignment'} <ChevronRightIcon /></button>
      </div>
    </div>
  );
}
