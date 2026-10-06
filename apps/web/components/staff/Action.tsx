'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * One console action: POST a JSON body to a staff route, then refresh the page's data.
 * When `note` is set the action asks for a written reason first; the API stores it in
 * the audit log (R3), so the field is never optional where the route requires it.
 */
/** Several routes answer 200 with `{decided: false, message}` and similar when the rules refuse. */
export function refused(json: unknown): boolean {
  if (!json || typeof json !== 'object') return false;
  const j = json as Record<string, unknown>;
  return ['ok', 'decided', 'requested', 'released', 'updated', 'opened'].some((k) => j[k] === false);
}

export function Action({
  url, body = {}, label, tone = 'ghost', note, noteRequired = true, confirm, done, size = 'sm', icon,
}: {
  url: string;
  body?: Record<string, unknown>;
  label: string;
  tone?: 'ghost' | 'ink' | 'primary' | 'danger';
  /** Field name for the written reason (e.g. "note", "reason"); its label follows after a colon: "reason:Why reject?" */
  note?: string;
  noteRequired?: boolean;
  confirm?: string;
  done?: string;
  size?: 'sm' | 'md';
  icon?: React.ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [field, prompt] = note ? (note.includes(':') ? note.split(/:(.*)/s, 2) as [string, string] : [note, 'Reason (kept in the audit log)']) : [null, null];
  const cls = `btn${size === 'sm' ? ' sm' : ''}${tone === 'ghost' ? ' ghost' : tone === 'ink' ? ' ink' : ''}`;
  const style = tone === 'danger' ? { background: 'var(--surface)', color: 'var(--bad)', borderColor: '#f2c7bf' } : undefined;

  async function send() {
    if (confirm && !window.confirm(confirm)) return;
    setBusy(true);
    setError(null);
    const payload = field ? { ...body, [field]: text.trim() } : body;
    const res = await fetch(`/api${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    const json = (await res.json().catch(() => null)) as { message?: string; reason?: string } | null;
    setBusy(false);
    if (!res.ok || refused(json)) {
      setError(json?.message ?? `Refused (${res.status}).`);
      return;
    }
    setOk(done ?? 'Done.');
    setOpen(false);
    setText('');
    router.refresh();
  }

  if (ok) return <span className="act-ok">{ok}</span>;
  if (field && open) {
    return (
      <div className="act-form" style={{ minWidth: 240 }}>
        <textarea className="input" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={prompt ?? ''} aria-label={prompt ?? 'Reason'} />
        <div className="btn-group">
          <button type="button" className={cls} style={style} disabled={busy || (noteRequired && text.trim().length < 3)} onClick={send}>{busy ? 'Saving…' : label}</button>
          <button type="button" className="btn sm ghost" onClick={() => { setOpen(false); setError(null); }}>Cancel</button>
        </div>
        {error && <span className="act-err">{error}</span>}
      </div>
    );
  }
  return (
    <span className="stack-8" style={{ display: 'inline-flex', gap: 4 }}>
      <button type="button" className={cls} style={style} disabled={busy} onClick={() => (field ? setOpen(true) : send())}>{icon}{busy ? 'Working…' : label}</button>
      {error && <span className="act-err">{error}</span>}
    </span>
  );
}
