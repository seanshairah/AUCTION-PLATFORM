'use client';

import { PaperAirplaneIcon } from '@heroicons/react/20/solid';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** Reply box for a ticket thread. The client key makes a double-click send once. */
export function Compose({ url, placeholder = 'Write a reply. The customer sees it on WhatsApp or the web, wherever they wrote from.' }: { url: string; placeholder?: string }) {
  const router = useRouter();
  const [body, setBody] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body, clientKey: key }) });
    setBusy(false);
    if (!res.ok) {
      setError(((await res.json().catch(() => null)) as { message?: string } | null)?.message ?? 'Not sent.');
      return;
    }
    setBody('');
    setKey(crypto.randomUUID());
    router.refresh();
  }
  return (
    <div className="stack-8">
      <textarea className="input" rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder={placeholder} aria-label="Reply"
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) void send(); }} />
      <div className="row between">
        <span className="small muted">{error ? <span className="act-err">{error}</span> : 'Ctrl + Enter to send'}</span>
        <button type="button" className="btn sm ink" disabled={busy || !body.trim()} onClick={send}><PaperAirplaneIcon /> {busy ? 'Sending…' : 'Send reply'}</button>
      </div>
    </div>
  );
}
