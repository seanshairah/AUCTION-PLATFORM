'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function Reply({ ticketId }: { ticketId: string }) {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="row" style={{ gap: 8 }}>
      <input className="input" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a reply" aria-label="Reply" />
      <button className="btn ghost" disabled={busy || !body.trim()} onClick={async () => {
        setBusy(true);
        await fetch(`/api/tickets/${ticketId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body, clientKey: crypto.randomUUID() }) });
        setBody(''); setBusy(false); router.refresh();
      }}>Send</button>
    </div>
  );
}
