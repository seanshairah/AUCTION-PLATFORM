'use client';

import { CheckIcon } from '@heroicons/react/20/solid';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Acknowledge each remaining warning on a draft rule set with one written reason.
 * Each warning is still acknowledged separately (one audit row per warning, per person).
 */
export function AckAll({ versionId, warningIds }: { versionId: string; warningIds: string[] }) {
  const router = useRouter();
  const [reason, setReason] = useState('');
  const [done, setDone] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!warningIds.length) return null;
  return (
    <div className="act-form">
      <textarea className="input" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason, e.g. “Reviewed with finance; placeholders stand until ABC confirms (A23).”" aria-label="Reason for acknowledging" />
      <div className="row between">
        <span className="small muted">{busy ? `Acknowledged ${done} of ${warningIds.length}…` : error ? <span className="act-err">{error}</span> : `${warningIds.length} warning${warningIds.length === 1 ? '' : 's'} left for you`}</span>
        <button type="button" className="btn sm ink" disabled={busy || reason.trim().length < 10} onClick={async () => {
          setBusy(true); setError(null); setDone(0);
          for (const id of warningIds) {
            const res = await fetch(`/api/staff/rule-sets/${versionId}/acknowledgements`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ warningId: id, reason: reason.trim() }) });
            if (!res.ok) { setError(((await res.json().catch(() => null)) as { message?: string } | null)?.message ?? 'Refused.'); break; }
            setDone((d) => d + 1);
          }
          setBusy(false);
          router.refresh();
        }}><CheckIcon /> Acknowledge all</button>
      </div>
    </div>
  );
}
