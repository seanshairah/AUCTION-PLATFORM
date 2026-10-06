'use client';

import { ChevronRightIcon } from '@heroicons/react/20/solid';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

const ROLE_TEXT: Record<string, string> = {
  admin: 'Every queue; approves as the second person',
  ops: 'Auctions, gate and the day’s operations',
  finance: 'Reconciliation, tax rates, approvals',
  risk: 'Registrations, link clusters, limits',
  support: 'Tickets, claims and late-payment appeals',
};

export function StaffSignIn({ accounts, next }: { accounts: Array<{ id: string; name: string; roles: string[] }>; next: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="pick">
      {accounts.map((a) => (
        <button
          key={a.id}
          type="button"
          disabled={busy !== null}
          onClick={async () => {
            setBusy(a.id);
            setError(null);
            const res = await fetch('/api/session/demo-staff', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: a.id }) });
            if (res.ok) {
              router.push(next);
              router.refresh();
            } else {
              setBusy(null);
              setError(((await res.json().catch(() => null)) as { message?: string } | null)?.message ?? 'Sign-in failed.');
            }
          }}
        >
          <span className="avatar">{a.name.replace(/\(.*\)/, '').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2)}</span>
          <span>
            <span className="w600">{a.name.replace(/\s*\(.*\)\s*$/, '')}</span>
            <span className="row" style={{ gap: 6, marginTop: 2 }}>
              {a.roles.map((r) => <span key={r} className="micro" style={{ color: 'var(--accent-text)' }}>{r}</span>)}
              <span className="small muted">· {busy === a.id ? 'Signing in…' : ROLE_TEXT[a.roles[0] ?? ''] ?? 'Staff'}</span>
            </span>
          </span>
          <ChevronRightIcon />
        </button>
      ))}
      {error && <p className="act-err">{error}</p>}
    </div>
  );
}
