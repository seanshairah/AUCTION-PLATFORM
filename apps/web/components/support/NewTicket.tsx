'use client';

import { ChatBubbleLeftRightIcon } from '@heroicons/react/20/solid';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

const CATEGORIES = [['payment', 'Payment'], ['collection', 'Collection'], ['delivery', 'Delivery'], ['bidding', 'Bidding'], ['account', 'My account'], ['selling', 'Selling'], ['other', 'Something else']] as const;

export function NewTicket() {
  const router = useRouter();
  const [f, setF] = useState({ category: 'payment', subject: '', body: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function send() {
    setBusy(true);
    const r = await fetch('/api/tickets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...f, channel: 'web', clientKey: crypto.randomUUID() }) });
    const j = (await r.json()) as { opened?: boolean; message?: string; number?: string };
    setBusy(false);
    if (j.opened) { setMsg({ ok: true, text: 'Sent. We reply here, within the reply-by time shown.' }); setF({ ...f, subject: '', body: '' }); router.refresh(); }
    else setMsg({ ok: false, text: j.message ?? 'Could not send your message.' });
  }
  return (
    <div className="nest">
      <div className="nest-head"><ChatBubbleLeftRightIcon /><h3>Ask us something</h3></div>
      <div className="nest-body stack">
        <div className="field"><label htmlFor="t-cat">About</label><select id="t-cat" className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <div className="field"><label htmlFor="t-sub">Subject</label><input id="t-sub" className="input" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} placeholder="For example: my EcoCash payment shows as pending" /></div>
        <div className="field"><label htmlFor="t-body">Message</label><textarea id="t-body" className="input" style={{ height: 110, padding: 12 }} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></div>
        {msg && <div className={`notice ${msg.ok ? 'good' : 'bad'}`}>{msg.text}</div>}
        <div><button className="btn" disabled={busy || f.subject.length < 3 || !f.body} onClick={send}>{busy ? 'Sending…' : 'Send'}</button></div>
      </div>
    </div>
  );
}
