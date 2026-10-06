'use client';

import { BellIcon } from '@heroicons/react/20/solid';
import { useRouter } from 'next/navigation';

interface Item { id: string; kind: string; title: string | null; text: string; at: string; read: boolean }

export function NotificationList({ items }: { items: Item[] }) {
  const router = useRouter();
  if (items.length === 0) return <div className="card empty"><BellIcon /><h3 className="w600">Nothing yet</h3><p>Outbid alerts, invoices and collection updates appear here as well as on WhatsApp.</p></div>;
  return (
    <div className="card">
      {items.map((n, i) => (
        <button
          key={n.id}
          type="button"
          onClick={async () => { if (!n.read) { await fetch(`/api/me/notifications/${n.id}/read`, { method: 'POST' }); router.refresh(); } }}
          className="row"
          style={{ width: '100%', textAlign: 'left', gap: 12, padding: '14px 16px', border: 0, borderTop: i ? '1px solid var(--line-soft)' : 0, background: n.read ? 'var(--surface)' : 'var(--accent-tint)', cursor: n.read ? 'default' : 'pointer', alignItems: 'flex-start' }}
        >
          <span style={{ width: 8, height: 8, borderRadius: '50%', marginTop: 7, flex: 'none', background: n.read ? 'transparent' : 'var(--accent)' }} />
          <span className="grow">
            {n.title && <span className="w600" style={{ display: 'block' }}>{n.title}</span>}
            <span className="ink-2">{n.text}</span>
          </span>
          <span className="small muted" style={{ whiteSpace: 'nowrap' }}>{new Date(n.at).toLocaleString('en-ZW', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Harare' })}</span>
        </button>
      ))}
    </div>
  );
}
