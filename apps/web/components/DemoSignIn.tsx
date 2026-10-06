'use client';

import { ChevronRightIcon } from '@heroicons/react/20/solid';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function DemoSignIn({ accounts, next }: { accounts: Array<{ id: string; name: string }>; next: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      {accounts.map((a, i) => (
        <button
          key={a.id}
          type="button"
          disabled={busy !== null}
          onClick={async () => {
            setBusy(a.id);
            const res = await fetch('/api/session/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: a.id }) });
            if (res.ok) {
              router.push(next);
              router.refresh();
            } else setBusy(null);
          }}
          className="row"
          style={{ width: '100%', gap: 12, padding: '16px 18px', border: 0, borderTop: i ? '1px solid var(--line-soft)' : 0, background: 'var(--surface)', cursor: 'pointer', textAlign: 'left' }}
        >
          <span className="avatar">{a.name.slice(0, 1)}</span>
          <span className="grow"><span className="w600">{a.name}</span><br /><span className="small muted">{busy === a.id ? 'Signing in…' : 'Demo bidder · fully verified'}</span></span>
          <ChevronRightIcon width={18} style={{ color: 'var(--muted)' }} />
        </button>
      ))}
    </div>
  );
}
