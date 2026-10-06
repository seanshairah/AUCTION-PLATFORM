'use client';

import { CheckBadgeIcon, DocumentTextIcon, PencilSquareIcon } from '@heroicons/react/20/solid';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

/** Shows the consignment note exactly as it will be signed; signing sends its hash back. */
export function SignNote({ consignmentId, signed }: { consignmentId: string; signed: boolean }) {
  const router = useRouter();
  const [note, setNote] = useState<{ text: string | null; sha256: string | null; message?: string } | null>(null);
  const [agree, setAgree] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void fetch(`/api/seller/consignments/${consignmentId}/note`, { cache: 'no-store' }).then(async (r) => setNote(await r.json()));
  }, [consignmentId, signed]);

  async function sign() {
    if (!note?.sha256) return;
    setBusy(true);
    const r = await fetch(`/api/seller/consignments/${consignmentId}/sign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha256: note.sha256 }) });
    const j = (await r.json()) as { signed: boolean; message: string };
    setResult({ ok: j.signed, text: j.message });
    setBusy(false);
    if (j.signed) router.refresh();
    else { setAgree(false); setNote(await (await fetch(`/api/seller/consignments/${consignmentId}/note`, { cache: 'no-store' })).json()); }
  }

  return (
    <div className="nest">
      <div className="nest-head"><DocumentTextIcon /><h3>Consignment note</h3>{note?.sha256 && <span className="micro" style={{ marginLeft: 'auto' }}>SHA-256 {note.sha256.slice(0, 12)}…</span>}</div>
      <div className="nest-body stack">
        {!note ? <p className="muted small">Preparing the note…</p> : note.text === null ? <div className="notice">{note.message}</div> : (
          <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12.5, lineHeight: 1.6, background: 'var(--wash)', border: '1px solid var(--line)', borderRadius: 8, padding: 16, maxHeight: 360, overflow: 'auto' }}>{note.text}</pre>
        )}
        {result && <div className={`notice ${result.ok ? 'good' : 'bad'}`}><CheckBadgeIcon /><span>{result.text}</span></div>}
        {signed ? (
          <span className="status good"><CheckBadgeIcon /> Signed. This note can no longer change.</span>
        ) : note?.sha256 ? (
          <div className="row" style={{ flexWrap: 'wrap', gap: 16 }}>
            <label className="check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I have read this note and agree to its terms</label>
            <button className="btn" disabled={!agree || busy} onClick={sign}><PencilSquareIcon /> {busy ? 'Signing…' : 'Sign the note'}</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
