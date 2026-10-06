'use client';

import { ScaleIcon } from '@heroicons/react/20/solid';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { refused } from './Action';

const REMEDIES = [
  ['none', 'Not upheld: no remedy'],
  ['partial_refund', 'Partial refund'],
  ['full_refund_and_return', 'Full refund and return'],
  ['repair_or_replace', 'Repair or replace'],
] as const;

/**
 * Decide a claim against the published inspection report (docs/17). Refunds above the
 * threshold need a second person: the API says so, and this form then raises the request.
 */
export function DisputeDecision({ disputeId, currency }: { disputeId: string; currency: string }) {
  const router = useRouter();
  const [remedy, setRemedy] = useState<string>('none');
  const [decision, setDecision] = useState('');
  const [refund, setRefund] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'bad' | 'good' | 'info'; text: string } | null>(null);
  const [needsApproval, setNeedsApproval] = useState(false);
  const refundMinor = refund ? String(Math.round(Number(refund) * 100)) : undefined;

  async function post(path: string, body: Record<string, unknown>) {
    setBusy(true);
    setMsg(null);
    const res = await fetch(`/api/staff/disputes/${disputeId}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = (await res.json().catch(() => null)) as { message?: string; reason?: string } | null;
    setBusy(false);
    return { ok: res.ok && !refused(json), json };
  }

  return (
    <div className="act-form">
      <div className="field">
        <label htmlFor={`r-${disputeId}`}>Remedy</label>
        <select id={`r-${disputeId}`} className="input" value={remedy} onChange={(e) => { setRemedy(e.target.value); setNeedsApproval(false); }}>
          {REMEDIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      {remedy.includes('refund') && (
        <div className="field">
          <label htmlFor={`a-${disputeId}`}>Refund ({currency === 'ZWG' ? 'ZiG' : 'US$'})</label>
          <input id={`a-${disputeId}`} className="input mono" inputMode="decimal" value={refund} onChange={(e) => setRefund(e.target.value.replace(/[^\d.]/g, ''))} placeholder={remedy === 'full_refund_and_return' ? 'Leave empty for the full amount' : '0.00'} />
        </div>
      )}
      <div className="field">
        <label htmlFor={`d-${disputeId}`}>Decision, as the buyer will read it</label>
        <textarea id={`d-${disputeId}`} className="input" rows={3} value={decision} onChange={(e) => setDecision(e.target.value)} placeholder="What you checked against the inspection report and why you decided this way." />
      </div>
      {msg && <div className={`notice ${msg.tone} small`}>{msg.text}</div>}
      <div className="btn-group">
        {needsApproval ? (
          <button type="button" className="btn sm ink" disabled={busy || decision.trim().length < 10} onClick={async () => {
            const r = await post('refund-approval', { remedy, reason: decision.trim(), ...(refundMinor ? { refundMinor } : {}) });
            setMsg(r.ok ? { tone: 'good', text: 'Sent to finance for a second approval.' } : { tone: 'bad', text: r.json?.message ?? 'Not sent.' });
            if (r.ok) router.refresh();
          }}>Ask finance to approve</button>
        ) : (
          <button type="button" className="btn sm ink" disabled={busy || decision.trim().length < 10} onClick={async () => {
            const r = await post('decision', { remedy, decision: decision.trim(), ...(refundMinor ? { refundMinor } : {}) });
            if (r.ok) { setMsg({ tone: 'good', text: 'Decided. The buyer has been told.' }); router.refresh(); return; }
            if (r.json?.reason === 'second_approval_required') setNeedsApproval(true);
            setMsg({ tone: r.json?.reason === 'second_approval_required' ? 'info' : 'bad', text: r.json?.message ?? 'Not decided.' });
          }}><ScaleIcon /> {busy ? 'Saving…' : 'Record decision'}</button>
        )}
      </div>
    </div>
  );
}
