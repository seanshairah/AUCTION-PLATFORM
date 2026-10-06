'use client';

import { BellAlertIcon, BellSlashIcon, TrashIcon } from '@heroicons/react/20/solid';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function SavedSearchActions({ id, alerts }: { id: string; alerts: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const call = async (method: 'PATCH' | 'DELETE', body?: unknown) => {
    setBusy(true);
    await fetch(`/api/me/saved-searches/${id}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    setBusy(false);
    router.refresh();
  };
  return (
    <div className="btn-group">
      <button type="button" className="btn sm ghost" disabled={busy} aria-pressed={alerts} onClick={() => call('PATCH', { alerts: !alerts })}>
        {alerts ? <><BellAlertIcon style={{ color: 'var(--accent-text)' }} /> Alerts on</> : <><BellSlashIcon /> Alerts off</>}
      </button>
      <button type="button" className="btn sm ghost" disabled={busy} aria-label="Delete saved search" onClick={() => call('DELETE')}><TrashIcon /></button>
    </div>
  );
}
