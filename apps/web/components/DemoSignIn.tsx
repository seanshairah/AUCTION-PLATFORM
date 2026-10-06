'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function DemoSignIn({ accounts, next }: { accounts: Array<{ id: string; name: string }>; next: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="accounts">
      {accounts.map((a) => (
        <button
          key={a.id}
          className="account-pick"
          disabled={busy !== null}
          onClick={async () => {
            setBusy(a.id);
            const res = await fetch('/api/session/demo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: a.id }) });
            if (res.ok) {
              router.push(next);
              router.refresh();
            } else setBusy(null);
          }}
        >
          <span className="avatar">{a.name.slice(0, 1)}</span>
          <span>
            <strong>{a.name}</strong>
            <div className="small muted">{busy === a.id ? 'Signing in…' : 'Demo bidder · fully verified'}</div>
          </span>
        </button>
      ))}
    </div>
  );
}
