'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

const LABEL: Record<string, string> = { warning: 'Warning', deposit_forfeit: 'Deposit kept', relist_fee: 'Relisting fee', tier_drop: 'Lower spending limit' };

export function Appeal({ caseId, steps }: { caseId: string; steps: string[] }) {
  const router = useRouter();
  const appealable = steps.filter((s) => s !== 'warning');
  const [chosen, setChosen] = useState<string[]>(appealable);
  const [grounds, setGrounds] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  if (appealable.length === 0) return null;
  return (
    <div className="stack-8">
      <span className="micro">Appeal</span>
      <div className="row" style={{ flexWrap: 'wrap' }}>{appealable.map((s) => <label key={s} className="check"><input type="checkbox" checked={chosen.includes(s)} onChange={(e) => setChosen(e.target.checked ? [...chosen, s] : chosen.filter((x) => x !== s))} /> {LABEL[s] ?? s}</label>)}</div>
      <textarea className="input" style={{ height: 80, padding: 10 }} value={grounds} onChange={(e) => setGrounds(e.target.value)} placeholder="What happened? For example, an EcoCash payment that failed on the due date." />
      {msg && <div className="notice good">{msg}</div>}
      <div><button className="btn sm" disabled={!chosen.length || grounds.trim().length < 10} onClick={async () => {
        const r = await fetch(`/api/me/defaults/${caseId}/appeal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ steps: chosen, grounds }) });
        const j = (await r.json()) as { message?: string };
        setMsg(j.message ?? 'Sent.'); router.refresh();
      }}>Send appeal</button></div>
    </div>
  );
}
